import { serve } from "bun";
import RSS from "rss";
import Parser from "rss-parser";
import { parse as parseHtml, TextNode, HTMLElement } from "node-html-parser";
import {
  filterArticlesByDate,
  formatDate,
  generateHistoricalRecaps,
  generateRecapForArticles,
} from "./recap";
import {
  getDailyRecaps,
  initializeStorage,
  readStorage,
  storeRecap,
} from "./storage";
import { DailyRecap } from "./types";
import { initializeDigCache } from "./digCache";
import { digRoutes } from "./routes/dig";

/**
 * Extracts domain from a URL for display purposes.
 * Returns the hostname without protocol or path.
 * Fallback to "Unknown" if URL parsing fails.
 *
 * @param url - The URL to extract domain from
 * @returns Domain string (e.g., "example.com")
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown";
  }
}

/**
 * Compute a safe absolute host base (protocol + host + port) to be used
 * when generating externally visible URLs.
 *
 * Rules:
 * - serverUrl = `http://localhost:${process.env.PORT || 3000}`
 * - HOST = process.env.HOST || serverUrl
 * - If PUBLIC_PORT is set: `${HOST(without trailing slash)}:${PUBLIC_PORT}`
 * - Else if HOST already has an explicit port: return HOST as-is
 * - Else: `${HOST(without trailing slash)}:${process.env.PORT || 3000}`
 *
 * Uses URL API to detect if HOST already contains a port.
 *
 * @returns absolute host base, like "http://example.com:PORT"
 */
function safeHostBase(): string {
  const serverUrl = `http://localhost:${process.env.PORT || 3000}`;
  const rawHost = process.env.HOST || serverUrl;
  const publicPort = process.env.PUBLIC_PORT?.toString().trim();

  let hostUrl: URL;
  try {
    hostUrl = new URL(rawHost);
  } catch {
    // Fallback to serverUrl if HOST is malformed
    hostUrl = new URL(serverUrl);
  }

  const hasPort = hostUrl.port !== "";
  const trimmedHost = rawHost.replace(/\/$/, "");

  if (publicPort && publicPort.length > 0) {
    return `${trimmedHost}:${publicPort}`;
  }

  if (hasPort) {
    return trimmedHost; // Use HOST as-is when it already includes a port
  }

  return `${trimmedHost}:${process.env.PORT || 3000}`;
}

/**
 * Rewrite all anchor hrefs in recap HTML to point to /dig with article_url only (no lang).
 * Adds target, rel, and referrerpolicy for safety.
 *
 * @param html - original recap HTML
 * @param hostBase - absolute base like http://host:port

 * @returns transformed HTML
 */
function rewriteLinksToDig(html: string, hostBase: string): string {
  try {
    const root = parseHtml(html);
    const anchors = root.querySelectorAll("a[href]");
    for (const a of anchors) {
      const orig = a.getAttribute("href") || "";
      if (!orig) continue;
      const url = `${hostBase}/dig?article_url=${encodeURIComponent(orig)}`;

      const newLink = new HTMLElement("a", {});
      newLink.setAttribute("href", url);
      newLink.setAttribute("target", "_blank");
      newLink.setAttribute("rel", "noopener noreferrer");
      newLink.setAttribute("referrerpolicy", "no-referrer");

      const italicNode = new HTMLElement("i", {});
      const supNode = new HTMLElement("sup", {});
      const textNode = new TextNode("AI Recap");

      newLink.appendChild(textNode);
      italicNode.appendChild(newLink);
      supNode.appendChild(italicNode);

      a.after('&nbsp;', supNode);
    }
    return root.toString();
  } catch {
    return html;
  }
}

/**
 * Builds an RSS feed from stored daily recaps.
 *
 * Algorithm:
 * 1. Create RSS feed with metadata derived from source feed URL
 * 2. Sort recaps by date (newest first)
 * 3. Add each recap as an RSS item with proper formatting
 * 4. Return XML string
 *
 * @param feedUrl - The source RSS feed URL
 * @param recaps - Array of DailyRecap objects to include
 * @returns RSS XML string
 */
function buildRSSFeed(feedUrl: string, recaps: DailyRecap[]): string {
  const domain = extractDomain(feedUrl);
  const hostBase = safeHostBase();
  const feedLang = "en"; // retained for RSS metadata only

  const feed = new RSS({
    title: `AI Daily Recap - ${domain}`,
    description: `Daily AI-generated summaries from ${feedUrl}`,
    feed_url: `${hostBase}/?feed=${encodeURIComponent(feedUrl)}`,
    site_url: feedUrl,
    language: feedLang,
  });

  // Sort recaps by date (newest first)
  const sortedRecaps = [...recaps].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  for (const recap of sortedRecaps) {
    const rewritten = rewriteLinksToDig(recap.html, hostBase);
    feed.item({
      title: `Daily Recap - ${recap.date}`,
      description: rewritten,
      url: feedUrl,
      guid: `${feedUrl}#${recap.date}`,
      date: new Date(recap.date),
    });
  }

  return feed.xml();
}

/**
 * Generates a daily recap for a specific feed for yesterday's date.
 * Fetches the feed, filters articles for yesterday, and generates recap if articles found.
 *
 * @param feedUrl - The RSS feed URL to process
 * @returns Promise that resolves when recap is generated and stored
 */
async function generateRecapForFeed(feedUrl: string): Promise<void> {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);

  // Get yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // Filter articles for yesterday
  const articlesForYesterday = filterArticlesByDate(feed.items, yesterday);

  if (articlesForYesterday.length > 0) {
    const html = await generateRecapForArticles(articlesForYesterday);

    const recap: DailyRecap = {
      date: formatDate(yesterday),
      html: html,
      articles: articlesForYesterday,
    };

    storeRecap(feedUrl, recap);
    console.log(
      `Generated recap for ${feedUrl} on ${formatDate(yesterday)}: ${articlesForYesterday.length} articles`,
    );
  } else {
    console.log(`No articles found for ${feedUrl} on ${formatDate(yesterday)}`);
  }
}

/**
 * Generates daily recaps for all tracked feeds.
 * Called by scheduler at midnight.
 * Processes all feeds in parallel with individual error handling.
 */
async function generateDailyRecapsForAllFeeds(): Promise<void> {
  console.log("Starting daily recap generation for all feeds...");
  const storage = readStorage();

  const feedKeys = Object.keys(storage);
  const promises = feedKeys.map(async (feedUrl) => {
    return generateRecapForFeed(feedUrl).catch((err) => {
      console.error(`Failed to generate recap for ${feedUrl}:`, err);
    });
  });

  await Promise.all(promises);
  console.log("Daily recap generation completed for all feeds");
}

// Initialize storage and dig cache at startup
initializeStorage();
initializeDigCache();
console.log("Storage initialized");

// Check for required environment variables
if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "WARNING: OPENROUTER_API_KEY not set - AI recap generation will fail",
  );
}

// Start HTTP server
const port = Number(process.env.PORT) || 3000;
serve({
  port: port,
  idleTimeout: 120,
  routes: {
    ...digRoutes(),
    /**
     * Main RSS endpoint.
     * Accepts `feed` query parameter and returns transformed RSS with AI recaps.
     * Automatically initializes and generates historical recaps for new feeds.
     */
    "/": async (req) => {
      try {
        const url = new URL(req.url);
        const feedUrl = url.searchParams.get("feed");

        if (!feedUrl) {
          return new Response("No feed specified", { status: 400 });
        }

        // Try to get existing feed recaps
        let recaps = getDailyRecaps(feedUrl);

        if (!recaps) {
          // If feed is new, initialize and generate historical recaps
          console.log(`New feed detected: ${feedUrl}`);
          console.log(
            "Generating historical recaps in the background (5 days)...",
          );

          try {
            generateHistoricalRecaps(feedUrl, 5).then(() => {
              console.log(`Historical recaps generated for ${feedUrl}`);
            });
          } catch (error) {
            console.error(
              `Failed to generate historical recaps for ${feedUrl}:`,
              error,
            );
            // Continue even if historical generation fails
          }

          // Refresh feed recaps after generation
          recaps = getDailyRecaps(feedUrl);
        }

        recaps = recaps || [];

        // Only giving 7 days of recaps
        const today = Date.now();
        const msInDay = 24 * 60 * 60 * 1000;
        const recentRecaps = recaps.filter(
          (r) => today - Date.parse(r.date) < msInDay * 7,
        );

        // Build RSS feed from stored recaps
        const rssXml = buildRSSFeed(feedUrl, recentRecaps);

        return new Response(rssXml, {
          headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
          },
        });
      } catch (error) {
        console.error("Error processing request:", error);
        return new Response(`Error: ${error}`, { status: 500 });
      }
    },

    /**
     * Minimal chat-like UI that auto-starts an initial stream for the article.
     */
  },
});

console.log(`AI Daily Recap server started on port ${port}`);
console.log("");
console.log("To add a new feed: http://ai-daily-recap?feed=<ENCODED_FEED_URL>");
console.log("");
console.log("Or with Node:");
console.log(
  `'http://ai-daily-recap:${port}?feed=' + encodeURIComponent('https://...')`,
);

const now = Date.now();
const msInDay = 24 * 60 * 60 * 1000;
const msFromMidnight = now % msInDay;
const msToMidnight = msInDay - msFromMidnight;

setTimeout(() => {
  // Will trigger at midnight
  setInterval(() => {
    // Will trigger every day at midnight
    generateDailyRecapsForAllFeeds().catch((err) => {
      console.error("Failed to generate daily recaps:", err);
    });
  }, msInDay);
}, msToMidnight);
