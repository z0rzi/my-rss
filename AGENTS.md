# RSS Feed Processing System - AI Agent Technical Documentation

## Project Overview

This is a multi-service RSS feed processing system designed to enhance RSS feeds with AI-generated summaries and image content. The system consists of three specialized microservices that transform RSS feeds through intelligent content analysis, image extraction, and AI-powered summarization.

**Architecture Pattern:** Microservices with HTTP endpoints, file-based caching, LLM integration, and Docker containerization.

**Primary Use Case:** RSS reader enhancement (Miniflux) to display AI-generated daily recaps and images from various content sources.

---

## Technology Stack

### Runtime & Language
- **Bun**: JavaScript/TypeScript runtime (replaces Node.js)
- **TypeScript**: Primary language (no explicit compilation step, Bun handles it)

### Core Dependencies
- `rss-parser@^3.13.0`: Parse incoming RSS feeds
- `rss@^1.2.2`: Generate transformed RSS XML output
- `node-html-parser@^7.0.1`: DOM manipulation for HTML scraping
- `image-size@^2.0.2`: Calculate image dimensions from binary data
- `@types/*`: TypeScript type definitions

### Infrastructure
- **Docker Compose**: Multi-container orchestration
- **PostgreSQL 13 (Alpine)**: Database for Miniflux
- **Miniflux**: RSS reader application (port 8034)

---

## Service Architecture

```
┌──────────────┐
│   Miniflux   │ (RSS Reader UI)
│   :8034      │
└──────────────┘
       │
       ├────────────────────────────────────────────┐
       │                     │                      │
       ▼                     ▼                      ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│reddit-parser │     │image-digger  │     │ai-daily-recap│
│  (internal)  │     │    :8033     │     │    :8032     │
└──────────────┘     └──────────────┘     └──────────────┘
       │                     │                      │
       ▼                     ▼                      ▼
 Reddit RSS API    Arbitrary RSS Feeds    Arbitrary RSS Feeds
                           │                       │
                           ▼                       ▼
                   Article HTML Pages      OpenRouter LLM API
```

---

## Service 1: reddit-parser

### Purpose
Transforms Reddit subreddit RSS feeds to extract direct image URLs from post lightbox elements.

### API Endpoint

**GET /** 
- **Query Parameter:** `sub` (required) - Subreddit name without "/r/" prefix
- **Example:** `/?sub=pics`
- **Response:** RSS XML feed with direct image links

### Algorithm Flow

1. **Fetch Reddit RSS:** `https://www.reddit.com/r/{sub}.rss`
2. **For each RSS item (parallel):**
   - Fetch the Reddit post HTML page (`item.link`)
   - Parse HTML and query selector: `faceplate-tracker[source=post_lightbox] a`
   - Extract `href` attribute (direct image URL)
   - If selector not found, fallback to original `item.link`
3. **Build output RSS feed:**
   - Preserve: `title`, `description`, `pubDate`
   - Replace: `url` with extracted image URL or fallback
4. **Return transformed RSS XML**

### Key Implementation Details

**Promise Pattern:**
```typescript
const proms = [] as Promise<void>[];
for (const item of inFeed.items) {
  const p = new Promise<{...}>(async (resolve, reject) => { ... });
  proms.push(p.then((res) => { outFeed.item(res); }));
}
await Promise.all(proms);
```
- All items processed in parallel (no sequential blocking)
- Each promise resolves with transformed item data
- RSS items added via `outFeed.item()` in `.then()` callback
- `Promise.all()` ensures all items complete before returning feed

**Error Handling:**
- Missing `sub` parameter → 400 Bad Request
- No explicit error handling for fetch failures or parsing errors (will throw)
- Always resolves with at least original link (defensive programming)

**Environment Variables:**
- `PORT`: Server port (default: 3000, Docker: 80)

---

## Service 2: image-digger

### Purpose
Fetches RSS feeds, extracts the largest image from each article, and serves transformed feed + cached image pages.

### API Endpoints

#### 1. GET /
**Main RSS transformation endpoint**

- **Query Parameter:** `feed` (required) - URL of source RSS feed
- **Example:** `/?feed=https://example.com/feed.rss`
- **Response:** RSS XML with image enclosures and article links
- **CORS:** Enabled (`Access-Control-Allow-Origin: *`)

**Algorithm Flow:**

1. **Fetch source RSS feed**
2. **Sort by date & limit to 10 most recent items**
   ```typescript
   inFeed.items.sort((a, b) => Date.parse(b.pubDate!) - Date.parse(a.pubDate!));
   inFeed.items = inFeed.items.slice(0, 10);
   ```
3. **For each item (parallel):**
   - Fetch article HTML (`item.link`)
   - Query all `img[src]` elements
   - Filter images: only `.jpg` or `.png` extensions
   - **Download ALL matching images** (as `bytes()`)
   - Calculate dimensions using `imageSize(blob)`
   - Find image with largest pixel area (`width * height`)
   - Cache result: `guid → {imageUrl, title, description}`
4. **Build output RSS feed:**
   - `url`: Points to `/article?guid={guid}` (self-hosted page)
   - `enclosure.url`: Direct image URL
   - `guid`: Original article GUID
5. **Return transformed RSS XML**

**Image Selection Logic:**
```typescript
let biggest = { size: 0, url: "" };
for (const img of imgs) {
  if (!img.blob) continue;
  const size = imageSize(img.blob);
  if (size.width * size.height > biggest.size) {
    biggest = { size: size.width * size.height, url: img.url };
  }
}
```

**Error Handling:**
- Missing `feed` parameter → 400 Bad Request
- No images found on page → `reject()` (item skipped, no RSS entry)
- Promise rejections handled silently (failed items don't break feed)

#### 2. GET /article
**Cached article viewer endpoint**

- **Query Parameter:** `guid` (required) - Article GUID from source RSS
- **Example:** `/article?guid=abc123`
- **Response:** HTML page displaying cached image
- **CORS:** Enabled

**HTML Template:**
```html
<html>
  <head>
    <title>${cache.title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body>
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; width: 100vw;">
      <img src="${cache.imageUrl}" style="max-width: 100%; max-height: 100%;">
      <p>${cache.description ?? ''}</p>
    </div>
  </body>
</html>
```

**Error Handling:**
- Missing `guid` parameter → 400 "No image specified"
- GUID not in cache → 404 "No image found"

### Cache Mechanism

**File:** `/tmp/rss-digger-cache.txt`

**Structure:**
```typescript
type CacheEntry = {
  guid: string;
  imageUrl: string;
  description: string;
  title: string;
}[]
```

**Operations:**

1. **Initialization:**
   ```typescript
   fs.writeFileSync(CACHE_FILE, JSON.stringify([]));
   ```
   - Overwrites cache on service restart (ephemeral)

2. **Read Cache:**
   ```typescript
   function getCache(): CacheEntry[]
   ```
   - Parses JSON from file
   - Returns fallback array on error

3. **Get Single Entry:**
   ```typescript
   function getCacheForGuid(guid: string): CacheEntry | null
   ```
   - Linear search through cache array
   - Returns `null` if not found

4. **Update Cache:**
   ```typescript
   function setCache(guid: string, imageUrl: string, title: string, description: string)
   ```
   - Updates existing entry if `guid` exists
   - Appends new entry if `guid` doesn't exist
   - **No size limit** (unbounded growth per session)
   - Writes entire cache to file on each update

**Cache Limitations:**
- No TTL (time-to-live)
- No LRU eviction (despite "10 most recent items" in feed)
- File I/O on every cache operation (not optimized for high throughput)
- Cache persists in `/tmp` (may be cleared on host reboot)

### CORS Implementation

```typescript
function withCors(original: Response): Response {
  const newHeaders = new Headers(original.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(original.body, {
    status: original.status,
    statusText: original.statusText,
    headers: newHeaders,
  });
}
```
- Clones response with added CORS headers
- Applied to both `/` and `/article` endpoints
- Allows cross-origin requests (unrestricted)

### Environment Variables

- **`HOST`** (required): Hostname for generating `/article` URLs
  - Example: `http://example.com` or `http://192.168.1.10`
  - Used in: `${HOST}:8033/article?guid=${encodeURIComponent(item.guid!)}`
  - Service throws error if not set
- **`PORT`**: Server port (default: 3000, Docker: 80)

---

## Service 3: ai-daily-recap

### Purpose
Generates AI-powered daily summaries of any RSS feed using Large Language Models (LLMs). Analyzes articles from each day and creates concise, intelligent recaps highlighting the most important and interesting stories.

### API Endpoint

**GET /**
- **Query Parameter:** `feed` (required) - URL of source RSS feed
- **Example:** `/?feed=https://news.example.com/rss`
- **Response:** RSS XML feed with AI-generated daily recaps

### Algorithm Flow

1. **Check if feed exists in storage**
   - If new feed → generate historical recaps (5 days)
   - If existing feed → return stored recaps
2. **Fetch source RSS feed using rss-parser**
3. **Group articles by date (YYYY-MM-DD format)**
4. **For each day with articles:**
   - Filter articles for that specific day
   - Limit to first 50 articles (LLM context management)
   - Send articles to LLM with curator prompt
   - LLM analyzes and generates markdown summary
   - Store recap in JSON file
5. **Build output RSS feed:**
   - Each item = one daily recap
   - Title: "Daily Recap - YYYY-MM-DD"
   - Description: Markdown-formatted AI summary
   - GUID: "{feedUrl}#{date}"
6. **Return RSS XML with daily recaps**

### Key Implementation Details

**Module Structure:**
```
ai-daily-recap/
├── src/
│   ├── ai.ts           # LLM integration (OpenRouter API)
│   ├── types.ts        # TypeScript type definitions
│   ├── storage.ts      # JSON file operations
│   ├── recap.ts        # Recap generation logic
│   └── index.ts        # HTTP server + scheduler
```

**Type Definitions (types.ts):**
```typescript
type ArticleReference = {
  title: string;           // Original article title
  link: string;            // URL to original article
  description: string;     // Article description/excerpt
  pubDate: string;         // ISO 8601 date string
};

type DailyRecap = {
  date: string;            // YYYY-MM-DD format
  markdown: string;        // LLM-generated recap
  articles: ArticleReference[];  // Source articles
};

type FeedRecaps = {
  feedUrl: string;         // Source RSS feed URL
  recaps: DailyRecap[];    // Array of daily recaps
};

type Storage = {
  feeds: FeedRecaps[];     // All tracked feeds
};
```

**Storage Operations (storage.ts):**

Storage file: `/tmp/ai-daily-recap-storage.json`

Functions:
1. `initializeStorage()` - Creates file with empty structure if missing
2. `readStorage()` - Reads and parses JSON, returns default on error
3. `writeStorage(storage)` - Writes with 2-space pretty-printing
4. `getFeedRecaps(feedUrl)` - Finds feed or returns null
5. `storeRecap(feedUrl, recap)` - Stores/updates recap for a date

**Recap Generation (recap.ts):**

Key functions:
1. `formatDate(date)` - Converts Date to "YYYY-MM-DD" string
2. `filterArticlesByDate(items, targetDate)` - Filters RSS items by calendar day
3. `generateRecapForArticles(articles, targetDate)` - Calls LLM to generate summary
4. `generateHistoricalRecaps(feedUrl, days)` - Generates past N days of recaps

**LLM Integration (ai.ts):**

```typescript
export enum AiModels {
  CLAUDE = "anthropic/claude-3.7-sonnet",
  GPT4o = "openai/gpt-4.1",
  GEMINI_FLASH = "google/gemini-2.0-flash-001",
  CHEAP = "google/gemini-2.0-flash-001",  // Default
}

export async function askAi(messages: AiMessage[], options?: AiOptions)
```

- Uses OpenRouter API for multi-model LLM access
- Default model: Gemini Flash (cost optimization)
- Logs failed responses to `/tmp/ai-response.json`
- Exits process on API errors

**LLM Prompt Structure:**

System message (curator instructions):
```
You are an intelligent news curator. Your job is to analyze a day's 
worth of articles and create a concise, engaging summary highlighting 
the most important and interesting stories.

Rules:
1. Focus on 3-5 major stories maximum
2. Include clickable links to original articles
3. Use markdown formatting
4. Be concise but informative
5. Prioritize newsworthy, impactful, or interesting stories
6. Ignore minor or repetitive stories
7. Write in professional but engaging tone
```

User message (formatted article list):
```
Here are today's articles:

1. [Article Title](https://example.com/article1)
   Description: Article description...

2. [Article Title 2](https://example.com/article2)
   Description: Another description...

Generate a daily recap.
```

**Daily Scheduler:**

Implementation in `index.ts`:
```typescript
// Runs every 60 seconds
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    await generateDailyRecapsForAllFeeds();
  }
}, 60000);
```

Process:
1. Check current time every minute
2. If 00:00 → trigger recap generation for all feeds
3. For each feed in storage:
   - Fetch RSS feed
   - Get yesterday's date
   - Filter articles from yesterday
   - Generate recap if articles found
   - Store recap in JSON
4. Process all feeds in parallel using `Promise.all()`
5. Individual feed errors don't stop others

**Error Handling:**

Request level:
- Missing `feed` parameter → 400 "No feed specified"
- RSS fetch failures → caught and logged, skip that feed
- LLM API errors → logged to file, process exits

Recap generation:
- No articles for a day → skip recap (no empty entries)
- Promise rejections → caught per-feed, don't break scheduler
- Storage read errors → return default empty structure

**Environment Variables:**
- `OPENROUTER_API_KEY` (required): API key for LLM access
- `PORT`: Server port (default: 3000, Docker: 80)

### Storage Mechanism

**File:** `/tmp/ai-daily-recap-storage.json`

**Structure Example:**
```json
{
  "feeds": [
    {
      "feedUrl": "https://news.example.com/rss",
      "recaps": [
        {
          "date": "2025-11-14",
          "markdown": "# Daily Recap - November 14, 2025\n\n## Story 1...",
          "articles": [
            {
              "title": "Breaking News",
              "link": "https://news.example.com/article1",
              "description": "Important development...",
              "pubDate": "2025-11-14T10:30:00Z"
            }
          ]
        }
      ]
    }
  ]
}
```

**Storage Characteristics:**
- Ephemeral (resets on container restart)
- No size limits (unbounded growth)
- Pretty-printed JSON (2 spaces) for debugging
- File write on every recap addition/update
- No concurrent access protection

**Read/Write Pattern:**
1. Read entire file into memory
2. Modify in-memory structure
3. Write entire structure back to file
4. No transactions or locks

### Performance Characteristics

**Bottlenecks:**
- **LLM API calls**: 1-5 seconds per recap generation
- **Network I/O**: RSS feed fetching
- **Article volume**: More articles = longer LLM processing time
- **Storage I/O**: File write on every recap update

**Parallelism:**
- Historical recaps generated sequentially (rate limit protection)
- Daily scheduler processes all feeds in parallel
- RSS feed fetching is async but not parallelized per feed

**Memory Usage:**
- Linear with number of tracked feeds
- Each recap stores full article metadata
- No memory limits or cleanup

**Typical Latency:**
- First request (new feed): 10-30 seconds (5 days of recaps)
- Subsequent requests: <1 second (cached recaps)
- Daily generation: 1-5 seconds per feed

**Optimization Opportunities:**
- Cache RSS feed responses (avoid re-fetching)
- Batch multiple days to single LLM call
- Stream LLM responses (partial updates)
- Use database instead of JSON file
- Implement recap expiration/archival
- Add request deduplication

### Date Handling

**Critical Implementation Details:**

Date format: Always "YYYY-MM-DD" string
```typescript
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
```

Article filtering by date:
```typescript
function filterArticlesByDate(items: Parser.Item[], targetDate: Date) {
  const targetDateStr = formatDate(targetDate);
  return items.filter(item => {
    if (!item.pubDate) return false;
    const itemDate = new Date(item.pubDate);
    return formatDate(itemDate) === targetDateStr;
  });
}
```

**Timezone Considerations:**
- Uses server's local timezone (not UTC)
- RSS pubDate parsed by JavaScript Date constructor
- Calendar day comparison (not 24-hour window)
- Midnight triggers based on server time

**Edge Cases:**
- Articles without pubDate → filtered out
- Multiple articles same timestamp → all included
- Articles spanning midnight boundary → separate days
- Future-dated articles → grouped by their date

### Historical Recap Generation

**Algorithm:**
```typescript
async function generateHistoricalRecaps(feedUrl: string, days: number = 5) {
  const parser = new Parser();
  const feed = await parser.parseURL(feedUrl);
  
  for (let i = 1; i <= days; i++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - i);
    
    const articles = filterArticlesByDate(feed.items, targetDate);
    
    if (articles.length > 0) {
      const markdown = await generateRecapForArticles(articles, targetDate);
      const recap: DailyRecap = {
        date: formatDate(targetDate),
        markdown,
        articles
      };
      storeRecap(feedUrl, recap);
    }
  }
}
```

**Key Points:**
- Runs on first request only (new feed detection)
- Goes back 5 days from current date
- Sequential processing (not parallel) to avoid rate limits
- Skips days with no articles (no empty recaps)
- Uses same LLM call as daily generation
- All historical recaps complete before returning first response

**User Experience:**
- First request takes 10-30 seconds (blocking)
- User sees 5 days of recaps immediately
- No loading states or partial results

### RSS Feed Building

**Output Structure:**
```typescript
const feed = new RSS({
  title: `AI Daily Recap - ${domain}`,
  description: `Daily AI-generated summaries from ${feedUrl}`,
  feed_url: `http://localhost:${PORT}/?feed=${encodeURIComponent(feedUrl)}`,
  site_url: feedUrl,
  language: "en"
});

for (const recap of sortedRecaps) {
  feed.item({
    title: `Daily Recap - ${recap.date}`,
    description: recap.markdown,  // Markdown in RSS description
    url: feedUrl,
    guid: `${feedUrl}#${recap.date}`,
    date: new Date(recap.date)
  });
}
```

**RSS Item Structure:**
- Title: "Daily Recap - YYYY-MM-DD"
- Description: Full markdown summary (may be long)
- URL: Points back to source feed (not AI service)
- GUID: Unique per feed+date combination
- Date: The day being recapped (not generation time)

**Sorting:** Newest recaps first (descending by date)

**Markdown in RSS:**
- Most RSS readers display markdown as plain text
- Some readers (including Miniflux) may render markdown
- Links remain clickable even as plain text
- Formatting preserved but not always rendered

---

## Docker Compose Configuration

### Services

1. **db** (postgres:13-alpine)
   - Database: `miniflux`
   - Credentials: `miniflux:m1n1f7ux`
   - Not exposed to host

2. **reddit-parser**
   - Build context: `./reddit-parser`
   - Internal only (no port mapping)
   - Accessed by Miniflux via container DNS name
   - ENV: `PORT=80`

3. **image-digger**
   - Build context: `./image-digger`
   - Host port: `8033:80`
   - ENV: `PORT=80`, `HOST=${HOST}` (from shell environment)
   - Restart policy: `always`

4. **ai-daily-recap**
   - Build context: `./ai-daily-recap`
   - Host port: `8032:80`
   - ENV: `PORT=80`, `OPENROUTER_API_KEY=${OPENROUTER_API_KEY}` (from shell environment)
   - Restart policy: `always`
   - Scheduler runs continuously (checks for midnight every minute)

5. **web** (miniflux/miniflux)
   - Host port: `8034:8080`
   - Database migrations auto-run
   - Default admin: `zorzi:Passclearlsl` ⚠️ **Hardcoded credentials**
   - Depends on: `db`

### Network
- Default bridge network (implicit)
- Services communicate via container names as DNS

---

## File Structure

```
RSS/
├── reddit-parser/
│   ├── src/
│   │   └── index.ts          # Main server (77 lines)
│   ├── package.json
│   ├── yarn.lock
│   ├── Dockerfile
│   └── .gitignore
├── image-digger/
│   ├── src/
│   │   └── index.ts          # Main server (228 lines)
│   ├── package.json
│   ├── yarn.lock
│   ├── Dockerfile
│   └── .gitignore
├── ai-daily-recap/
│   ├── src/
│   │   ├── ai.ts             # LLM integration (70 lines)
│   │   ├── types.ts          # Type definitions (48 lines)
│   │   ├── storage.ts        # JSON storage ops (90 lines)
│   │   ├── recap.ts          # Recap generation (150+ lines)
│   │   └── index.ts          # Server + scheduler (225+ lines)
│   ├── package.json
│   ├── Dockerfile
│   └── documentation.md      # Detailed implementation guide
├── docker-compose.yml
└── .gitignore
```

**Note:** reddit-parser and image-digger have single-file implementations. ai-daily-recap uses modular architecture.

---

## Data Flow Example

### Reddit Parser Flow
```
User Request: /?sub=aww
    ↓
Fetch: https://www.reddit.com/r/aww.rss
    ↓
Parse RSS (10 posts)
    ↓
[Parallel] Fetch each post HTML
    ↓
Extract: faceplate-tracker[source=post_lightbox] a[href]
    ↓
Build RSS with direct image URLs
    ↓
Return RSS XML
```

### Image Digger Flow
```
User Request: /?feed=https://blog.example.com/feed
    ↓
Fetch & parse source RSS
    ↓
Sort by date, take 10 newest
    ↓
[Parallel] For each article:
    Fetch HTML
    Find all <img src="*.jpg|*.png">
    Download all images as bytes
    Calculate dimensions
    Select largest by pixel area
    Cache: guid → {imageUrl, title, description}
    ↓
Build RSS:
  - url: http://{HOST}:8033/article?guid={guid}
  - enclosure: {url: direct_image_url}
    ↓
Return RSS XML
```

### Article Viewing Flow
```
RSS Reader clicks: http://{HOST}:8033/article?guid=abc123
    ↓
Read cache file: /tmp/rss-digger-cache.txt
    ↓
Find entry where guid === "abc123"
    ↓
Render HTML page with:
  - <img src="{cached imageUrl}">
  - <p>{cached description}</p>
    ↓
Return HTML
```

### AI Daily Recap Flow (First Request)
```
User Request: /?feed=https://news.example.com/rss
    ↓
Check storage: feed not found (new feed)
    ↓
Initialize feed in storage
    ↓
Fetch RSS feed
    ↓
Generate historical recaps (5 days):
  For each day (going backwards):
    Filter articles by date
    If articles found:
      Format articles for LLM
      Call OpenRouter API with curator prompt
      Receive markdown summary
      Store recap in JSON
    ↓
Build RSS feed:
  For each stored recap:
    title: "Daily Recap - YYYY-MM-DD"
    description: markdown summary
    guid: "{feedUrl}#{date}"
    ↓
Return RSS XML with 5 days of recaps
```

### AI Daily Recap Flow (Subsequent Requests)
```
User Request: /?feed=https://news.example.com/rss
    ↓
Check storage: feed found
    ↓
Read stored recaps from JSON
    ↓
Build RSS feed from cached recaps
    ↓
Return RSS XML (instant, <1 second)
```

### Daily Scheduler Flow
```
Every minute: Check time
    ↓
If 00:00 server time:
    Read storage → get all tracked feeds
    ↓
For each feed (parallel):
    Fetch RSS feed
    Get yesterday's date
    Filter articles from yesterday
    If articles found:
        Format articles for LLM
        Call OpenRouter API
        Receive markdown summary
        Store recap in JSON
    Log errors but continue with other feeds
    ↓
All feeds processed → wait for next midnight
```

---

## Critical Implementation Details

### 1. Promise Handling Patterns

Both services use the same pattern for parallel processing:

```typescript
const proms = [] as Promise<void>[];
for (const item of inFeed.items) {
  const p = new Promise<ItemType>(async (resolve, reject) => {
    // async work
    resolve(result);
  });
  proms.push(
    p.then((res) => {
      outFeed.item(res);  // Side effect in .then()
    })
  );
}
await Promise.all(proms);
```

**Why this pattern:**
- Allows parallel execution of all items
- Handles side effects (adding to RSS feed) outside the promise constructor
- `Promise.all()` waits for all items before returning feed

**Gotcha:** Rejections in `image-digger` will cause `Promise.all()` to reject early. Some items may be skipped silently.

### 2. Regex Image Filtering

```typescript
if (!imageUrl || !/.(jpg|png)$/.test(imageUrl)) {
  return { url: "", blob: null };
}
```

**Limitations:**
- Only matches `.jpg` and `.png` (not `.jpeg`, `.JPG`, `.PNG`)
- Case-sensitive
- Requires extension at end of URL (fails with query params: `image.jpg?v=123`)
- No validation of actual image content type

### 3. Image Size Calculation

```typescript
const size = imageSize(img.blob);
if (size.width * size.height > biggest.size) {
  biggest = { size: size.width * size.height, url: img.url };
}
```

**Algorithm:** Naive pixel area comparison
- Doesn't account for aspect ratio
- Doesn't consider file size (bandwidth)
- No error handling if `imageSize()` fails

### 4. Type Safety Gaps

Both services use non-null assertions extensively:
```typescript
item.title!
item.link!
item.pubDate!
```

**Risk:** Runtime errors if RSS feed doesn't contain expected fields.

### 5. No Rate Limiting

Both services fetch external URLs without:
- Retry logic
- Timeout configuration
- Rate limiting
- Concurrent request limits

**Risk:** Can be overwhelmed by large feeds or slow external servers.

### 6. Bun Server Configuration

All services use `serve()` with minimal configuration:
```typescript
serve({
  port: process.env.PORT || 3000,
  routes: {
    "/": async (req) => { ... }
  }
});
```

**Default behavior:**
- Single route per service (except image-digger with 2)
- No middleware
- No request logging
- No error boundaries

### 7. LLM Integration Pattern (ai-daily-recap)

**OpenRouter API Call:**
```typescript
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: AiModels.CHEAP,
    messages: [systemMessage, userMessage]
  })
});
```

**Error Handling:**
- API errors → logged to `/tmp/ai-response.json`
- Process exits on API failure (fail-fast)
- No retry logic
- No timeout configuration
- No rate limiting protection

**Cost Optimization:**
- Uses Gemini Flash as default (cheapest)
- Limits articles to 50 per day
- No streaming (full response only)
- No caching of LLM responses

**Gotchas:**
- API key must be set or service fails at startup with warning
- Long article descriptions → large context → higher cost
- No validation of API key format
- No fallback models if primary fails

### 8. Scheduler Implementation (ai-daily-recap)

**Naive Polling Approach:**
```typescript
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    await generateDailyRecapsForAllFeeds();
  }
}, 60000);
```

**Limitations:**
- Checks every minute (wasteful for 23 hours)
- No guarantee runs exactly at midnight (may miss if service busy)
- If generation takes >1 minute, may trigger multiple times
- No distributed locking (single instance only)
- No missed run recovery (if service down at midnight)

**Alternative Approaches (Not Implemented):**
- Cron-like scheduling (node-cron, etc.)
- Event-driven triggers (webhooks)
- Message queue (Redis, RabbitMQ)
- Serverless functions (AWS Lambda scheduled events)

---

## Development Considerations

### Running Locally

**Prerequisites:**
- Bun runtime installed
- Environment variable `HOST` set (for image-digger)

**Commands:**
```bash
# reddit-parser
cd reddit-parser
bun src/index.ts

# image-digger
export HOST=http://localhost
cd image-digger
bun src/index.ts

# ai-daily-recap
export OPENROUTER_API_KEY=your_key_here
cd ai-daily-recap
bun src/index.ts
```

### Running with Docker

```bash
# Set required environment variables
export HOST=http://your-server-ip
export OPENROUTER_API_KEY=your_openrouter_key

# Or use .env file (recommended)
cat > .env <<EOF
HOST=http://localhost
OPENROUTER_API_KEY=sk-or-v1-...
EOF

# Start all services
docker compose up -d

# View logs
docker compose logs -f reddit-parser
docker compose logs -f image-digger
docker compose logs -f ai-daily-recap

# Access services
# Miniflux: http://localhost:8034
# image-digger: http://localhost:8033
# ai-daily-recap: http://localhost:8032
```

### Testing Endpoints

```bash
# reddit-parser (inside Docker network or locally)
curl "http://localhost:3000/?sub=aww"

# image-digger
curl "http://localhost:8033/?feed=https://example.com/feed.rss"

# Article viewer
curl "http://localhost:8033/article?guid=some-guid-from-cache"

# ai-daily-recap
curl "http://localhost:8032/?feed=https://news.example.com/rss"

# Check ai-daily-recap storage
docker compose exec ai-daily-recap cat /tmp/ai-daily-recap-storage.json | jq .
```

### Common Issues

1. **image-digger fails to start:**
   - Ensure `HOST` environment variable is set
   - Check `/tmp` directory is writable

2. **No images extracted:**
   - Check if target site uses `.jpg`/`.png` extensions
   - Verify images are in `<img src="...">` tags (not CSS backgrounds)
   - Check network connectivity to external sites

3. **Article returns 404:**
   - GUID might not be in cache (ephemeral storage)
   - Service may have restarted (cache resets)

4. **RSS feed is empty:**
   - Check source feed has valid items
   - Verify all promises are resolving (not rejecting)
   - Check for network timeouts on slow external sites

5. **ai-daily-recap fails to start:**
   - Ensure `OPENROUTER_API_KEY` is set (check logs for warning)
   - Verify API key is valid (test with curl)
   - Check `/tmp` directory is writable

6. **No recaps generated:**
   - Check source feed has articles with valid pubDate
   - Verify articles exist for the requested dates
   - Check `/tmp/ai-response.json` for LLM API errors
   - Ensure OpenRouter account has credits/quota

7. **Historical recaps incomplete:**
   - Check source feed history (may not have 5 days of articles)
   - First request may timeout if LLM calls are slow
   - Check logs for individual day failures

8. **Daily recaps not triggering at midnight:**
   - Verify container timezone matches expected midnight
   - Check scheduler logs (runs every minute)
   - Ensure no long-running recap generation blocking check
   - Service may have restarted during midnight window

---

## Security Considerations

⚠️ **This is a development/personal project with security trade-offs:**

1. **Hardcoded admin credentials** in `docker-compose.yml`
2. **No input validation** on URLs (SSRF vulnerability)
3. **Unrestricted CORS** (`Access-Control-Allow-Origin: *`)
4. **No authentication** on services
5. **No request size limits** (memory exhaustion possible)
6. **Cache grows unbounded** (disk space issues)
7. **Executes arbitrary HTTP requests** to user-supplied URLs

**DO NOT expose these services to the public internet without additional security layers.**

### Additional Risks (ai-daily-recap)

8. **API key exposure** in logs or environment
9. **Unbounded LLM costs** (no usage limits)
10. **Process exit on API error** (service availability)
11. **No validation of feed URLs** (can fetch any URL)
12. **LLM prompt injection** (malicious article content)

---

## Performance Characteristics

### reddit-parser
- **Bottleneck:** Reddit post page fetches (network I/O)
- **Parallelism:** All items processed simultaneously
- **Memory:** Linear with feed size (all items in memory)
- **Typical latency:** 2-5 seconds for 10-item feed

### image-digger
- **Bottleneck:** Image downloads (downloads ALL images on page)
- **Parallelism:** All items processed simultaneously, all images per item in parallel
- **Memory:** High (stores all image blobs in memory during processing)
- **Disk I/O:** File write on every cache update
- **Typical latency:** 5-15 seconds for 10-item feed (depends on image count per page)

### ai-daily-recap
- **Bottleneck:** LLM API calls (1-5 seconds per recap)
- **Parallelism:** Historical recaps sequential, daily scheduler parallel across feeds
- **Memory:** Linear with number of feeds and recaps stored
- **Disk I/O:** File write on every recap storage
- **Typical latency:** 
  - First request: 10-30 seconds (5 LLM calls)
  - Cached requests: <1 second
  - Daily generation: 1-5 seconds per feed
- **Cost:** Variable (depends on LLM model and article count)

**Optimization opportunities (all services):**
- Add concurrency limits (e.g., process 3 items at a time)
- Stream image downloads instead of loading into memory
- Use in-memory cache or database instead of file system
- Add HTTP caching headers to responses
- Implement LRU cache eviction
- Cache RSS feed responses (avoid re-fetching)
- Batch multiple LLM requests
- Use cheaper/faster LLM models
- Implement request deduplication

---

## Extension Points

### Adding New Selectors (reddit-parser)
Modify the selector at line 45-46:
```typescript
const elem = root.querySelector(
  "faceplate-tracker[source=post_lightbox] a"
);
```

### Supporting More Image Formats (image-digger)
Update regex at line 176:
```typescript
if (!imageUrl || !/.(jpg|png|jpeg|webp|gif)$/i.test(imageUrl)) {
```

### Adding Request Logging
Wrap route handlers:
```typescript
"/": async (req) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  // existing code
}
```

### Adding Timeout Protection
```typescript
const res = await Promise.race([
  fetch(item.link!),
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), 10000)
  )
]);
```

---

## Debugging Tips

### Enable Verbose Logging
Add console.log statements:
```typescript
console.log('Fetched feed:', inFeed.title);
console.log('Processing items:', inFeed.items.length);
console.log('Found images:', imgs.filter(i => i.blob).length);
```

### Inspect Cache Contents
```bash
# Image digger cache
cat /tmp/rss-digger-cache.txt | jq .

# AI recap storage
cat /tmp/ai-daily-recap-storage.json | jq .

# AI error logs
cat /tmp/ai-response.json | jq .
```

### Test LLM Integration (ai-daily-recap)
```typescript
// Test askAi function
import { askAi } from './ai';

const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say hello!' }
];

const response = await askAi(messages);
console.log('LLM Response:', response);
```

### Test Date Filtering (ai-daily-recap)
```typescript
// Test filterArticlesByDate
import { filterArticlesByDate, formatDate } from './recap';

const testDate = new Date('2025-11-14');
console.log('Target date:', formatDate(testDate));

const articles = filterArticlesByDate(feedItems, testDate);
console.log(`Found ${articles.length} articles for ${formatDate(testDate)}`);
```

### Test HTML Parsing
```typescript
// reddit-parser
const res = await fetch('https://www.reddit.com/...').then(r => r.text());
const root = parse(res);
console.log(root.querySelector('faceplate-tracker[source=post_lightbox] a'));

// image-digger
const elems = root.querySelectorAll('img[src]');
console.log('Image URLs:', elems.map(e => e.getAttribute('src')));
```

### Monitor Docker Logs
```bash
# All services
docker compose logs -f --tail=100

# Specific services
docker compose logs -f ai-daily-recap
docker compose logs -f image-digger
docker compose logs -f reddit-parser

# Filter for errors
docker compose logs ai-daily-recap | grep -i error

# Watch scheduler checks (ai-daily-recap runs every minute)
docker compose logs -f ai-daily-recap | grep -i "midnight\|recap"
```

### Manually Trigger Recap Generation
```bash
# Connect to running container
docker compose exec ai-daily-recap /bin/sh

# Inside container, trigger recap via API
bun -e "
import('./src/recap.js').then(m => 
  m.generateHistoricalRecaps('https://news.example.com/rss', 1)
)"
```

---

## Future Improvements (Not Implemented)

- [ ] Add request timeout configuration
- [ ] Implement LRU cache with size limits
- [ ] Add Prometheus metrics endpoints
- [ ] Support WEBP, AVIF, GIF image formats
- [ ] Add case-insensitive regex for extensions
- [ ] Implement retry logic with exponential backoff
- [ ] Add health check endpoints (`/health`)
- [ ] Use Redis for shared cache between instances
- [ ] Add request validation middleware
- [ ] Implement rate limiting per feed URL
- [ ] Add unit tests (currently none)
- [ ] Support authentication for private feeds
- [ ] Add OpenAPI/Swagger documentation
- [ ] Implement circuit breaker for failing feeds

---

## Quick Reference

### Environment Variables
| Service | Variable | Required | Default | Purpose |
|---------|----------|----------|---------|---------|
| reddit-parser | `PORT` | No | 3000 | Server port |
| image-digger | `PORT` | No | 3000 | Server port |
| image-digger | `HOST` | **YES** | - | Hostname for article URLs |
| ai-daily-recap | `PORT` | No | 3000 | Server port |
| ai-daily-recap | `OPENROUTER_API_KEY` | **YES** | - | API key for LLM access |

### Port Mapping
| Service | Internal | External | Access |
|---------|----------|----------|--------|
| Miniflux | 8080 | 8034 | http://localhost:8034 |
| image-digger | 80 | 8033 | http://localhost:8033 |
| ai-daily-recap | 80 | 8032 | http://localhost:8032 |
| reddit-parser | 80 | - | Internal only |
| PostgreSQL | 5432 | - | Internal only |

### File Paths
- Image cache: `/tmp/rss-digger-cache.txt`
- AI recap storage: `/tmp/ai-daily-recap-storage.json`
- AI error logs: `/tmp/ai-response.json`
- Services: `./reddit-parser/src/index.ts`, `./image-digger/src/index.ts`, `./ai-daily-recap/src/`
- Config: `./docker-compose.yml`

---

**Last Updated:** Generated for AI assistant consumption
**Codebase Version:** Current as of documentation generation
**Maintained By:** Single developer (personal project)
