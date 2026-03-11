#!/usr/bin/env node
import assert from 'assert/strict';
import { analyzeItem, dedupeItems, parseFeedItems, summarizeProposals } from '../scripts/remote-capability-monitor.mjs';

const rssFixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Claude Code Remote Control Keeps Your Agent Local and Puts it in Your Pocket - DevOps.com</title>
      <link>https://news.google.com/rss/articles/example</link>
      <pubDate>Tue, 10 Mar 2026 08:00:00 GMT</pubDate>
      <description>&lt;a href="https://example.com"&gt;Claude Code Remote Control keeps your agent local and lets you steer it from your phone browser&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;DevOps.com&lt;/font&gt;</description>
      <source url="https://devops.com">DevOps.com</source>
    </item>
  </channel>
</rss>`;

const atomFixture = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/937253475/v2.1.72</id>
    <updated>2026-03-10T00:43:03Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/anthropics/claude-code/releases/tag/v2.1.72"/>
    <title>v2.1.72</title>
    <content type="html">&lt;ul&gt;&lt;li&gt;Added CLAUDE_CODE_DISABLE_CRON environment variable to immediately stop scheduled cron jobs mid-session&lt;/li&gt;&lt;li&gt;Improved voice input transcription accuracy for repo names and common dev terms&lt;/li&gt;&lt;li&gt;Reduced false-positive bash permission prompts&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
</feed>`;

const newsSource = {
  id: 'claude-code-remote-control-news',
  name: 'Claude Code Remote Control news',
  type: 'google_news_rss',
  target: 'claude-code',
  baseWeight: 3,
};

const releaseSource = {
  id: 'anthropics-claude-code-releases',
  name: 'anthropics/claude-code releases',
  type: 'atom',
  target: 'claude-code',
  baseWeight: 2,
};

const rssItems = parseFeedItems('google_news_rss', rssFixture, newsSource);
assert.equal(rssItems.length, 1);
assert.equal(rssItems[0].publisher, 'DevOps.com');
assert.match(rssItems[0].summary, /phone browser/i);

const newsAnalysis = analyzeItem(rssItems[0], newsSource);
assert.equal(newsAnalysis.interesting, true);
assert.ok(newsAnalysis.score >= 10);
assert.ok(newsAnalysis.reasons.some((reason) => /remote-control/i.test(reason)));
assert.ok(newsAnalysis.proposals.some((proposal) => /remote control cards/i.test(proposal)));
assert.ok(newsAnalysis.proposals.some((proposal) => /Phone-first layout/i.test(proposal)));

const atomItems = parseFeedItems('atom', atomFixture, releaseSource);
assert.equal(atomItems.length, 1);
assert.equal(atomItems[0].headline, 'anthropics/claude-code releases: v2.1.72');
assert.match(atomItems[0].summary, /scheduled cron jobs/i);

const releaseAnalysis = analyzeItem(atomItems[0], releaseSource);
assert.equal(releaseAnalysis.interesting, true);
assert.ok(releaseAnalysis.proposals.some((proposal) => /Detached run queues/i.test(proposal)));
assert.ok(releaseAnalysis.proposals.some((proposal) => /Batch permission inboxes/i.test(proposal)));
assert.ok(releaseAnalysis.proposals.some((proposal) => /Voice briefings/i.test(proposal)));

const deduped = dedupeItems([newsAnalysis, { ...newsAnalysis, sourceId: 'duplicate-source', score: newsAnalysis.score - 1 }]);
assert.equal(deduped.length, 1);

const proposals = summarizeProposals([newsAnalysis, releaseAnalysis]);
assert.ok(proposals.length >= 3);
assert.ok(proposals[0].count >= 1);

console.log('test-remote-capability-monitor: ok');
