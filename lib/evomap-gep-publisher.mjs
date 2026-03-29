import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(value, fallback = 'v1') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveOverridePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeJson(value, fallback = null) {
  if (!trimString(value)) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function lowerJsonText(value) {
  try {
    return JSON.stringify(value || {}).toLowerCase();
  } catch {
    return String(value || '').toLowerCase();
  }
}

export function getEvomapHubUrl() {
  return trimString(process.env.REMOTELAB_EVOMAP_HUB_URL) || 'https://evomap.ai';
}

export function getEvomapNodeConfigPath() {
  return resolveOverridePath(process.env.REMOTELAB_EVOMAP_NODE_CONFIG_FILE)
    || join(homedir(), '.evomap', 'config.json');
}

export function buildA2AMessageEnvelope(messageType, senderId, payload = {}, options = {}) {
  const envelope = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: trimString(messageType),
    message_id: trimString(options.messageId) || `msg_${Date.now()}_${randomBytes(4).toString('hex')}`,
    timestamp: trimString(options.timestamp) || new Date().toISOString(),
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  if (trimString(senderId)) {
    envelope.sender_id = trimString(senderId);
  }
  return envelope;
}

export function canonicalizeEvomapAsset(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeEvomapAsset).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeEvomapAsset(value[key])}`).join(',')}}`;
  }
  return 'null';
}

export function computeEvomapAssetId(asset = {}, options = {}) {
  const excludedFields = new Set(Array.isArray(options.excludeFields)
    ? options.excludeFields
    : ['asset_id']);
  const clean = {};
  for (const [key, value] of Object.entries(asset || {})) {
    if (excludedFields.has(key)) continue;
    clean[key] = value;
  }
  return `sha256:${createHash('sha256').update(canonicalizeEvomapAsset(clean), 'utf8').digest('hex')}`;
}

export async function loadEvomapNodeConfig(options = {}) {
  const configPath = trimString(options.configPath) || getEvomapNodeConfigPath();

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = normalizeJson(raw, {});
    return {
      configPath,
      configured: !!(trimString(parsed?.node_id || parsed?.nodeId) && trimString(parsed?.node_secret || parsed?.nodeSecret)),
      nodeId: trimString(parsed?.node_id || parsed?.nodeId),
      nodeSecret: trimString(parsed?.node_secret || parsed?.nodeSecret),
      claimUrl: trimString(parsed?.claim_url || parsed?.claimUrl),
      claimCode: trimString(parsed?.claim_code || parsed?.claimCode),
      referredBy: trimString(parsed?.referred_by || parsed?.referredBy),
    };
  } catch {
    return {
      configPath,
      configured: false,
      nodeId: '',
      nodeSecret: '',
      claimUrl: '',
      claimCode: '',
      referredBy: '',
    };
  }
}

export async function saveEvomapNodeConfig(input = {}, options = {}) {
  const configPath = trimString(options.configPath) || getEvomapNodeConfigPath();
  const existing = await loadEvomapNodeConfig({ configPath });
  const record = {
    node_id: trimString(input.nodeId) || existing.nodeId,
    node_secret: trimString(input.nodeSecret) || existing.nodeSecret,
    claim_url: trimString(input.claimUrl) || existing.claimUrl,
    claim_code: trimString(input.claimCode) || existing.claimCode,
    referred_by: trimString(input.referredBy) || existing.referredBy,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return configPath;
}

async function parseResponse(response) {
  const text = await response.text();
  const parsed = normalizeJson(text, null);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: parsed ?? { raw: text },
  };
}

function getRetryDelayMs(result = {}, attempt = 0) {
  const hinted = Number.parseInt(result?.body?.retry_after_ms, 10);
  if (Number.isInteger(hinted) && hinted > 0) return hinted;
  if (result?.status === 429) return Math.min(15000, 1500 * (attempt + 1));
  if (result?.status === 503) return Math.min(12000, 2000 * (attempt + 1));
  if (result?.status >= 500) return Math.min(12000, 1200 * (attempt + 1));
  return 0;
}

function isRetryableResult(result = {}) {
  return result?.status === 429 || result?.status >= 500;
}

function buildRequestUrl(pathname) {
  return new URL(pathname, getEvomapHubUrl()).toString();
}

export async function postEvomapJson(pathname, body = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable');
  }

  const retries = normalizePositiveInteger(options.retries, 0, { min: 0, max: 12 });
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 15000, { min: 1000, max: 120000 });
  const authToken = trimString(options.authToken);

  let lastFailure = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(buildRequestUrl(pathname), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = await parseResponse(response);
      clearTimeout(timeout);

      if (parsed.ok) return parsed;

      lastFailure = parsed;
      if (attempt >= retries || !isRetryableResult(parsed)) return parsed;
      await sleep(getRetryDelayMs(parsed, attempt));
      continue;
    } catch (error) {
      clearTimeout(timeout);
      const failure = {
        ok: false,
        status: error?.name === 'AbortError' ? 408 : 599,
        headers: null,
        body: {
          error: error?.name === 'AbortError' ? 'timeout' : 'transport_failed',
          message: error?.message || 'request failed',
        },
      };
      lastFailure = failure;
      if (attempt >= retries) return failure;
      await sleep(getRetryDelayMs(failure, attempt));
    }
  }

  return lastFailure || {
    ok: false,
    status: 599,
    headers: null,
    body: {
      error: 'transport_failed',
      message: 'request failed before a response was received',
    },
  };
}

function createResultError(action, result = {}) {
  const message = trimString(result?.body?.message)
    || trimString(result?.body?.error)
    || `${action} failed with HTTP ${result?.status || 0}`;
  const error = new Error(`${action}: ${message}`);
  error.action = action;
  error.result = result;
  return error;
}

function getBodyPayload(body = {}) {
  return body?.payload && typeof body.payload === 'object' ? body.payload : {};
}

function extractBundleId(body = {}) {
  const payload = getBodyPayload(body);
  return trimString(payload?.bundle_id)
    || trimString(payload?.computed_bundle_id)
    || trimString(body?.bundle_id)
    || trimString(body?.computed_bundle_id);
}

function extractDecision(body = {}) {
  const payload = getBodyPayload(body);
  return trimString(payload?.decision) || trimString(body?.decision);
}

function extractHint(body = {}) {
  const payload = getBodyPayload(body);
  return trimString(payload?.hint) || trimString(body?.hint);
}

function extractComputedAssets(body = {}) {
  const payload = getBodyPayload(body);
  return Array.isArray(payload?.computed_assets)
    ? payload.computed_assets.map((item) => ({
      type: trimString(item?.type),
      asset_id: trimString(item?.asset_id),
    }))
    : [];
}

function extractEstimatedFee(body = {}) {
  const payload = getBodyPayload(body);
  return Number.isFinite(payload?.estimated_fee) ? payload.estimated_fee : null;
}

function extractValidationReason(body = {}) {
  const payload = getBodyPayload(body);
  return trimString(payload?.reason) || trimString(body?.reason);
}

function isValidationAccepted(result = {}) {
  const payload = getBodyPayload(result?.body);
  const reason = extractValidationReason(result?.body);
  return result?.ok && (payload?.valid === true || reason === 'duplicate_asset');
}

function buildWatchErrorSummary(error) {
  const result = error?.result || {};
  return {
    action: trimString(error?.action) || 'evomap publish',
    status: Number.isInteger(result?.status) ? result.status : null,
    error: trimString(result?.body?.error),
    message: trimString(result?.body?.message) || error?.message || '',
    retryable: isRetryableResult(result),
  };
}

function getWatchDelayMs(result = {}, attempt = 0, options = {}) {
  const baseDelayMs = normalizePositiveInteger(options.attemptIntervalMs, 10000, { min: 1000, max: 600000 });
  const jitterMs = normalizePositiveInteger(options.attemptJitterMs, 1500, { min: 0, max: 120000 });
  const hintedDelayMs = getRetryDelayMs(result, attempt);
  const floorDelayMs = Math.max(baseDelayMs, hintedDelayMs);
  if (jitterMs <= 0) return floorDelayMs;
  return floorDelayMs + Math.floor(Math.random() * (jitterMs + 1));
}

function isDuplicatePublishResult(result = {}) {
  const haystack = lowerJsonText(result?.body);
  return result?.status === 409 || haystack.includes('duplicate');
}

function isAlreadyPublishedResult(result = {}) {
  const haystack = lowerJsonText(result?.body);
  return haystack.includes('already published') || haystack.includes('already_published');
}

function extractRecipeId(body = {}) {
  return trimString(body?.recipe?.id)
    || trimString(body?.recipe_id)
    || trimString(body?.id)
    || trimString(body?.data?.id);
}

export async function ensureEvomapNode(options = {}) {
  const current = options.currentNode || await loadEvomapNodeConfig(options);
  if (current.configured && !options.rotateSecret) {
    return {
      ...current,
      created: false,
    };
  }

  const payload = {
    capabilities: {
      publishing: true,
      recipe_creation: true,
    },
    model: trimString(options.modelName) || 'gpt-5',
    identity_doc: trimString(options.identityDoc)
      || 'RemoteLab minimal publisher node for de-identified operational Gene Recipes.',
    constitution: trimString(options.constitution)
      || 'Publish only de-identified abstractions. No raw private data. Keep EvoMap integration isolated from local service routing.',
    env_fingerprint: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
    },
  };

  if (options.rotateSecret) {
    payload.rotate_secret = true;
  }

  const envelope = buildA2AMessageEnvelope('hello', current.nodeId, payload);
  const result = await postEvomapJson('/a2a/hello', envelope, {
    fetchImpl: options.fetchImpl,
    retries: options.retries ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
  });
  if (!result.ok) throw createResultError('evomap hello', result);

  const responsePayload = result.body?.payload || {};
  const saved = {
    nodeId: trimString(responsePayload?.your_node_id),
    nodeSecret: trimString(responsePayload?.node_secret) || current.nodeSecret,
    claimUrl: trimString(responsePayload?.claim_url),
    claimCode: trimString(responsePayload?.claim_code),
    referredBy: trimString(options.referredBy) || current.referredBy,
  };

  await saveEvomapNodeConfig(saved, options);
  return {
    configPath: trimString(options.configPath) || getEvomapNodeConfigPath(),
    configured: true,
    created: true,
    nodeId: saved.nodeId,
    nodeSecret: saved.nodeSecret,
    claimUrl: saved.claimUrl,
    claimCode: saved.claimCode,
    referredBy: saved.referredBy,
  };
}

function buildHotelHousekeepingCapsuleContent() {
  return [
    'Task shape: de-identified hotel housekeeping operations reporting.',
    'Inputs: workload ledger, attendance ledger, linen/laundry ledger, amenity ledger.',
    'Outputs: weekly summary, monthly summary, staff ranking, room-type mix, linen cost per room, amenity cost per room, exception narrative.',
    'Method: normalize ledgers to the same reporting period, recalculate payout logic from rules, compute per-room cost, and surface missing-data gaps explicitly.',
    'Privacy rule: do not include guest records, employee names, room numbers, property identifiers, or raw sensitive source files in the published asset.',
  ].join(' ');
}

export function listBuiltinEvomapRecipeProfiles() {
  return [
    {
      id: 'hotel-housekeeping-analysis',
      description: 'De-identified hotel housekeeping reporting strategy distilled into one Gene + Capsule + Recipe chain.',
    },
  ];
}

export function buildBuiltinEvomapRecipeProfile(profileId = 'hotel-housekeeping-analysis', options = {}) {
  if (trimString(profileId) && trimString(profileId) !== 'hotel-housekeeping-analysis') {
    throw new Error(`Unknown evomap-gep profile: ${profileId}`);
  }

  const releaseTag = slugify(options.versionTag || 'v1');
  const idSuffix = releaseTag.replace(/-/g, '_');
  const prettyTag = trimString(options.versionTag) || 'v1';
  const pricePerExecution = normalizePositiveInteger(options.pricePerExecution, 5, { min: 1, max: 9999 });
  const maxConcurrent = normalizePositiveInteger(options.maxConcurrent, 1, { min: 1, max: 20 });
  const recipeTitle = trimString(options.recipeTitle) || `Hotel Housekeeping Reporting Recipe · ${prettyTag}`;

  const gene = {
    type: 'Gene',
    schema_version: '1.5.0',
    id: `gene_hotel_housekeeping_reporting_${idSuffix}`,
    category: 'optimize',
    summary: 'De-identified hotel housekeeping reporting workflow that normalizes workload, incentive, linen, and amenity ledgers into a manager-ready diagnostic output.',
    description: 'Derived from a de-identified hotel operations workflow. Focuses on ledger normalization, room-type-aware productivity review, cost-per-room metrics, and exception surfacing without exposing property-specific data.',
    domain: 'data_analysis',
    signals_match: [
      'hotel|酒店',
      'housekeeping|客房',
      'piece-rate|计件',
      'attendance|考勤',
      'linen|布草|洗涤',
      'amenities|耗品',
      'weekly report|周报',
      'monthly report|月报',
    ],
    preconditions: [
      'Input data is de-identified and aggregated at workload level.',
      'Attendance, workload, linen, and amenity ledgers can be aligned by reporting period.',
    ],
    strategy: [
      'Normalize attendance, room workload, linen, and amenity ledgers to the same reporting period.',
      'Recalculate incentive totals using configurable room-type and status rules instead of trusting final totals blindly.',
      'Derive weekly and monthly room counts, staff ranking, and room-type mix from the normalized workload table.',
      'Compute linen cost per room and amenity cost per room, then flag high-spend categories and week-over-week anomalies.',
      'Generate a short management narrative with baseline metrics, exception explanations, and missing-data gaps.',
    ],
    constraints: {
      max_files: 12,
      forbidden_paths: ['.git', 'node_modules', 'secrets', 'private'],
    },
    epigenetic_marks: [],
    model_name: trimString(options.modelName) || 'gpt-5',
  };
  gene.asset_id = computeEvomapAssetId(gene);

  const capsule = {
    type: 'Capsule',
    schema_version: '1.5.0',
    id: `capsule_hotel_housekeeping_reporting_${idSuffix}`,
    trigger: ['hotel', 'housekeeping', 'operations-reporting', 'data-analysis'],
    gene: gene.asset_id,
    summary: 'Validated a de-identified hotel housekeeping reporting playbook covering workload normalization, payout explanation, and cost-per-room exception review.',
    confidence: 0.78,
    blast_radius: { files: 1, lines: 1 },
    outcome: { status: 'success', score: 0.78 },
    success_streak: 1,
    env_fingerprint: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    source_type: 'original',
    domain: 'data_analysis',
    content: buildHotelHousekeepingCapsuleContent(),
    model_name: trimString(options.modelName) || 'gpt-5',
  };
  capsule.asset_id = computeEvomapAssetId(capsule);

  return {
    profileId: 'hotel-housekeeping-analysis',
    releaseTag,
    chainId: `chain_hotel_housekeeping_reporting_${idSuffix}`,
    gene,
    capsule,
    recipe: {
      title: recipeTitle,
      description: 'Publishes one de-identified hotel housekeeping analysis gene as a reusable recipe for structured operational review.',
      genes: [{ gene_asset_id: gene.asset_id, position: 0 }],
      price_per_execution: pricePerExecution,
      max_concurrent: maxConcurrent,
    },
  };
}

export async function publishEvomapAssetBundle(profile = {}, options = {}) {
  const node = options.node || await ensureEvomapNode(options);
  const envelope = buildA2AMessageEnvelope('publish', node.nodeId, {
    assets: [profile.gene, profile.capsule],
    ...(trimString(profile.chainId) ? { chain_id: profile.chainId } : {}),
  });
  const result = await postEvomapJson('/a2a/publish', envelope, {
    authToken: node.nodeSecret,
    fetchImpl: options.fetchImpl,
    retries: options.retries ?? 6,
    timeoutMs: options.timeoutMs ?? 15000,
  });
  if (!result.ok && !isDuplicatePublishResult(result)) {
    throw createResultError('evomap publish', result);
  }

  return {
    ok: result.ok || isDuplicatePublishResult(result),
    duplicate: isDuplicatePublishResult(result),
    status: result.status,
    body: result.body,
    bundleId: extractBundleId(result.body),
    decision: extractDecision(result.body),
    hint: extractHint(result.body),
    node,
  };
}

export async function validateEvomapAssetBundle(profile = {}, options = {}) {
  const node = options.node || await ensureEvomapNode(options);
  const envelope = buildA2AMessageEnvelope('publish', node.nodeId, {
    assets: [profile.gene, profile.capsule],
    ...(trimString(profile.chainId) ? { chain_id: profile.chainId } : {}),
  });
  const result = await postEvomapJson('/a2a/validate', envelope, {
    authToken: node.nodeSecret,
    fetchImpl: options.fetchImpl,
    retries: options.validateRetries ?? options.retries ?? 2,
    timeoutMs: options.timeoutMs ?? 15000,
  });

  return {
    ok: isValidationAccepted(result),
    valid: isValidationAccepted(result),
    status: result.status,
    body: result.body,
    reason: extractValidationReason(result.body),
    computedAssets: extractComputedAssets(result.body),
    bundleId: extractBundleId(result.body),
    estimatedFee: extractEstimatedFee(result.body),
    node,
    result,
  };
}

export async function createEvomapRecipe(recipe = {}, options = {}) {
  const node = options.node || await ensureEvomapNode(options);
  const body = {
    sender_id: node.nodeId,
    title: trimString(recipe.title),
    description: trimString(recipe.description),
    genes: Array.isArray(recipe.genes) ? recipe.genes : [],
    price_per_execution: normalizePositiveInteger(recipe.price_per_execution, 5, { min: 1, max: 9999 }),
    max_concurrent: normalizePositiveInteger(recipe.max_concurrent, 1, { min: 1, max: 20 }),
  };
  const result = await postEvomapJson('/a2a/recipe', body, {
    authToken: node.nodeSecret,
    fetchImpl: options.fetchImpl,
    retries: options.retries ?? 3,
    timeoutMs: options.timeoutMs ?? 15000,
  });
  if (!result.ok) throw createResultError('evomap recipe create', result);

  return {
    ok: true,
    status: result.status,
    recipeId: extractRecipeId(result.body),
    body: result.body,
    node,
  };
}

export async function publishEvomapRecipe(recipeId, options = {}) {
  const node = options.node || await ensureEvomapNode(options);
  const result = await postEvomapJson(`/a2a/recipe/${encodeURIComponent(trimString(recipeId))}/publish`, {
    sender_id: node.nodeId,
  }, {
    authToken: node.nodeSecret,
    fetchImpl: options.fetchImpl,
    retries: options.retries ?? 3,
    timeoutMs: options.timeoutMs ?? 15000,
  });
  if (!result.ok && !isAlreadyPublishedResult(result)) {
    throw createResultError('evomap recipe publish', result);
  }

  return {
    ok: result.ok || isAlreadyPublishedResult(result),
    alreadyPublished: isAlreadyPublishedResult(result),
    status: result.status,
    recipeId: extractRecipeId(result.body) || trimString(recipeId),
    body: result.body,
    node,
  };
}

export async function runEvomapRecipePublishWorkflow(options = {}) {
  const profile = buildBuiltinEvomapRecipeProfile(options.profileId, options);
  if (options.dryRun) {
    return {
      dryRun: true,
      profileId: profile.profileId,
      releaseTag: profile.releaseTag,
      assetBundle: {
        chainId: profile.chainId,
        assets: [profile.gene, profile.capsule],
      },
      recipeDraft: options.skipRecipe ? null : profile.recipe,
    };
  }

  const node = await ensureEvomapNode(options);
  const validation = options.validateBeforePublish === false
    ? null
    : await validateEvomapAssetBundle(profile, {
      ...options,
      node,
    });
  if (validation && !validation.valid) {
    throw createResultError('evomap validate', validation.result);
  }

  const bundle = await publishEvomapAssetBundle(profile, {
    ...options,
    node,
  });

  let recipe = null;
  if (!options.skipRecipe) {
    const created = await createEvomapRecipe(profile.recipe, {
      ...options,
      node,
    });
    const published = await publishEvomapRecipe(created.recipeId, {
      ...options,
      node,
    });
    recipe = {
      title: profile.recipe.title,
      recipeId: created.recipeId || published.recipeId,
      createdStatus: created.status,
      publishedStatus: published.status,
      alreadyPublished: published.alreadyPublished === true,
    };
  }

  return {
    dryRun: false,
    profileId: profile.profileId,
    releaseTag: profile.releaseTag,
    validation: validation
      ? {
        valid: validation.valid,
        status: validation.status,
        reason: validation.reason,
        bundleId: validation.bundleId,
        computedAssets: validation.computedAssets,
        estimatedFee: validation.estimatedFee,
      }
      : null,
    node: {
      nodeId: node.nodeId,
      claimUrl: node.claimUrl,
      claimCode: node.claimCode,
      configPath: node.configPath,
      created: node.created === true,
    },
    bundle: {
      geneAssetId: profile.gene.asset_id,
      capsuleAssetId: profile.capsule.asset_id,
      chainId: profile.chainId,
      duplicate: bundle.duplicate === true,
      publishStatus: bundle.status,
      bundleId: bundle.bundleId,
      decision: bundle.decision,
      hint: bundle.hint,
    },
    recipe,
  };
}

export async function runEvomapRecipePublishWatch(options = {}) {
  if (options.dryRun) {
    return runEvomapRecipePublishWorkflow(options);
  }

  const maxAttempts = normalizePositiveInteger(options.publishAttempts, 24, { min: 1, max: 240 });
  const validateBeforePublish = options.validateBeforePublish !== false;
  const profile = validateBeforePublish
    ? buildBuiltinEvomapRecipeProfile(options.profileId, options)
    : null;
  let lastError = null;
  let validation = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!validation && validateBeforePublish) {
        const validationResult = await validateEvomapAssetBundle(profile, options);
        if (!validationResult.valid) {
          throw createResultError('evomap validate', validationResult.result);
        }
        validation = {
          valid: validationResult.valid,
          status: validationResult.status,
          reason: validationResult.reason,
          bundleId: validationResult.bundleId,
          computedAssets: validationResult.computedAssets,
          estimatedFee: validationResult.estimatedFee,
        };
      }

      const result = await runEvomapRecipePublishWorkflow({
        ...options,
        validateBeforePublish: false,
      });
      return {
        ...result,
        validation: validation || result.validation,
        watch: {
          attemptsUsed: attempt,
          attemptsConfigured: maxAttempts,
          retried: attempt > 1,
          lastError,
        },
      };
    } catch (error) {
      lastError = buildWatchErrorSummary(error);
      if (!lastError.retryable || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(getWatchDelayMs(error?.result, attempt - 1, options));
    }
  }

  throw new Error('evomap publish watch exhausted without a final result');
}
