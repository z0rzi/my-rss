# RSS Feed Enhancement System

A Docker-based RSS feed enhancement system that transforms standard RSS feeds with powerful image extraction capabilities. Built with Bun, TypeScript, and Miniflux.

## 🎯 What Does This Do?

This system enhances RSS feeds by extracting and highlighting images, making your feed reading experience more visual and engaging. It consists of specialized services that work together to process feeds from various sources.

## 📦 Services Overview

### 1. **reddit-parser**
Transforms Reddit subreddit RSS feeds by extracting direct image links from posts. Instead of getting Reddit's post page, you get the actual image URL.

- **Access**: Internal service (not exposed)
- **Use case**: Better image viewing from Reddit posts

### 2. **image-digger**
Analyzes any RSS feed, visits each article, finds the largest image, and creates a new feed with those images prominently featured.

- **Port**: 8033
- **Use case**: Image-focused feeds from any source (blogs, news sites, etc.)
- **Features**: Caches processed images for faster subsequent loads

### 3. **ai-daily-recap**
Generates AI-powered daily summaries of any RSS feed using Large Language Models. Instead of reading every article, get a concise, intelligent recap highlighting the most important stories.

- **Port**: 8032
- **Use case**: AI-generated daily summaries from any RSS feed
- **Features**: 
  - Automatic daily recaps at midnight
  - Generates 5 days of historical recaps on first request
  - Intelligent story selection and summarization
  - Markdown-formatted summaries with links

### 4. **Miniflux** (Web Interface)
A minimalist and opinionated RSS reader where you can add your enhanced feeds.

- **Port**: 8034
- **Default credentials**: 
  - Username: `zorzi`
  - Password: `???`

### 5. **PostgreSQL Database**
Stores Miniflux data (feeds, articles, user preferences).

## ✅ Prerequisites

- Docker
- Docker Compose
- Your machine's host IP address or domain name (for `image-digger`)
- OpenRouter API key (for `ai-daily-recap`)

## 🚀 Setup Instructions

### 1. Set Environment Variables

Required environment variables:
- `HOST` - For `image-digger` to generate proper article links
- `OPENROUTER_API_KEY` - For `ai-daily-recap` to access LLM services

**Option A: Using a `.env` file (recommended)**

Create a `.env` file in the project root:

```bash
# For local development
HOST=http://localhost

# For production (use your server's IP or domain)
# HOST=http://192.168.1.100
# HOST=http://yourserver.com

# OpenRouter API key for AI daily recaps
OPENROUTER_API_KEY=your_api_key_here
```

**Option B: Export before running**

```bash
export HOST=http://localhost
export OPENROUTER_API_KEY=your_api_key_here
```

### 2. Start the Services

```bash
docker compose up -d
```

This will:
- Build the `reddit-parser`, `image-digger`, and `ai-daily-recap` services
- Pull and start Miniflux and PostgreSQL
- Set up the database and create the admin user

### 3. Access Miniflux

Open your browser and navigate to:
```
http://localhost:8034
```

Login with the default credentials (or change them in `docker-compose.yml` before starting).

## 📖 Usage Examples

### Using reddit-parser

The reddit-parser service is designed to be used internally by Miniflux or other RSS readers.

**Feed URL format:**
```
http://reddit-parser/?sub=SUBREDDIT_NAME
```

**Examples:**
- `http://reddit-parser/?sub=cats` - Cat pictures from r/cats
- `http://reddit-parser/?sub=EarthPorn` - Landscape images from r/EarthPorn
- `http://reddit-parser/?sub=wallpapers` - Wallpapers from r/wallpapers

**To add to Miniflux:**
1. Open Miniflux (http://localhost:8034)
2. Go to "Feeds" → "Add Feed"
3. Enter the feed URL: `http://reddit-parser/?sub=cats`
4. Click "Submit"

### Using image-digger

The image-digger service extracts the largest image from any RSS feed's articles.

**Feed URL format:**
```
http://localhost:8033/?feed=ENCODED_FEED_URL
```

**Examples:**
```bash
# For a blog feed
http://localhost:8033/?feed=https://blog.example.com/feed.xml

# For a news site
http://localhost:8033/?feed=https://news.example.com/rss
```

**To add to Miniflux:**
1. Open Miniflux (http://localhost:8034)
2. Go to "Feeds" → "Add Feed"
3. Enter: `http://image-digger:80/?feed=https://blog.example.com/feed.xml`
   - Note: Use `image-digger:80` when adding from within Miniflux (internal Docker network)
   - Use `localhost:8033` when accessing from your browser
4. Click "Submit"

### Using ai-daily-recap

The ai-daily-recap service generates AI-powered daily summaries of any RSS feed.

**Feed URL format:**
```
http://localhost:8032/?feed=ENCODED_FEED_URL
```

**Examples:**
```bash
# For a news site
http://localhost:8032/?feed=https://news.example.com/rss

# For a blog
http://localhost:8032/?feed=https://blog.example.com/feed.xml
```

**Features:**
- **Automatic Daily Recaps**: Runs at 00:00 server time to generate recaps for all tracked feeds
- **Historical Data**: On first request, generates recaps for the past 5 days (if articles are available)
- **Smart Summaries**: AI analyzes articles and highlights 3-5 most important stories
- **Markdown Format**: Summaries include clickable links to original articles

**To add to Miniflux:**
1. Open Miniflux (http://localhost:8034)
2. Go to "Feeds" → "Add Feed"
3. Enter: `http://ai-daily-recap:80/?feed=https://news.example.com/rss`
   - Note: Use `ai-daily-recap:80` when adding from within Miniflux (internal Docker network)
   - Use `localhost:8032` when accessing from your browser
4. Click "Submit"
5. The service will generate 5 days of historical recaps on first access

## ⚙️ Configuration

### Changing Miniflux Credentials

Edit `docker-compose.yml` before the first run:

```yaml
web:
  environment:
    - ADMIN_USERNAME=your_username
    - ADMIN_PASSWORD=your_password
```

### Changing Ports

**Miniflux (default: 8034):**
```yaml
web:
  ports:
    - "YOUR_PORT:8080"
```

**image-digger (default: 8033):**
```yaml
image-digger:
  ports:
    - "YOUR_PORT:80"
```

### Setting the HOST Variable

For production deployments, update the `HOST` in your `.env` file:

```bash
# Use your server's public IP or domain
HOST=http://your-server-ip

# Or with a domain
HOST=https://yourdomain.com
```

This is critical for `image-digger` to generate correct article links.

## 🔧 Service Details

### reddit-parser
- **Runtime**: Bun
- **Language**: TypeScript
- **How it works**: 
  1. Fetches the Reddit RSS feed for the specified subreddit
  2. Follows each post link
  3. Extracts the direct image URL from Reddit's lightbox viewer
  4. Returns a new RSS feed with direct image links

### image-digger
- **Runtime**: Bun
- **Language**: TypeScript
- **How it works**:
  1. Fetches the source RSS feed
  2. Visits each article link
  3. Downloads all images and analyzes their dimensions
  4. Identifies the largest image by pixel count
  5. Creates a new feed with the largest images
  6. Caches results to avoid re-processing
- **Endpoints**:
  - `/` - Main RSS feed endpoint (accepts `?feed=` parameter)
  - `/article` - Individual article viewer (accepts `?guid=` parameter)

### ai-daily-recap
- **Runtime**: Bun
- **Language**: TypeScript
- **AI Provider**: OpenRouter (supports Claude, GPT-4, Gemini, and more)
- **How it works**:
  1. Fetches the source RSS feed
  2. Groups articles by date
  3. On first request, generates recaps for the past 5 days
  4. Automatically generates new recaps daily at midnight
  5. Uses LLM to analyze articles and create concise summaries
  6. Highlights 3-5 most important/interesting stories per day
  7. Returns recaps as an RSS feed with markdown summaries
- **Storage**: JSON file at `/tmp/ai-daily-recap-storage.json` (ephemeral, resets on restart)
- **Scheduler**: Runs every minute, checks for midnight to trigger daily recap generation

## 🛠️ Development

### Rebuilding Services

After making code changes:

```bash
docker-compose up -d --build
```

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f reddit-parser
docker compose logs -f image-digger
docker compose logs -f ai-daily-recap
docker compose logs -f web
```

### Stopping Services

```bash
docker compose down
```

### Removing All Data

```bash
docker compose down -v
```

## 📝 Notes

- `image-digger` limits feeds to the 10 most recent items to optimize performance
- Images are cached in `/tmp/rss-digger-cache.txt` within the container
- Only `.jpg` and `.png` images are considered by `image-digger`
- `ai-daily-recap` generates recaps for up to 50 articles per day to manage LLM context size
- AI recaps are stored in `/tmp/ai-daily-recap-storage.json` (ephemeral storage)
- The scheduler in `ai-daily-recap` checks every minute for midnight to trigger daily recaps
- The database credentials in `docker-compose.yml` are for development only - change them for production use

## 🐛 Troubleshooting

**Issue**: image-digger feeds show broken article links

**Solution**: Make sure the `HOST` environment variable is set correctly to your server's accessible address.

---

**Issue**: Can't access Miniflux at localhost:8034

**Solution**: Check if the service is running with `docker-compose ps` and view logs with `docker-compose logs web`

---

**Issue**: reddit-parser not finding images

**Solution**: Some Reddit posts may not have images in the lightbox format. The service will fall back to the original post link.

---

**Issue**: ai-daily-recap not generating summaries

**Solution**: 
1. Check that `OPENROUTER_API_KEY` is set correctly in your `.env` file or environment
2. View logs with `docker compose logs ai-daily-recap` to see any API errors
3. Verify the source RSS feed is accessible and has valid articles
4. Check `/tmp/ai-response.json` in the container for detailed API response errors

---

**Issue**: ai-daily-recap summaries are empty or missing

**Solution**: The service only generates recaps for days with articles. If the source feed has no articles for a specific date, no recap will be generated for that day.

## 📄 License

MIT
