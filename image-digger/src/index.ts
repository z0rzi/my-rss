import { serve } from "bun";
import { imageSize } from "image-size";
import { parse } from "node-html-parser";
import RSS from "rss";
import Parser from "rss-parser";
import fs from "fs";

const HOST = process.env.HOST;
const CACHE_FILE = `/tmp/rss-digger-cache.txt`;
fs.writeFileSync(CACHE_FILE, JSON.stringify([]));

if (!HOST) {
  throw new Error("HOST environment variable is not set");
}

function getCache(): {
  guid: string;
  imageUrl: string;
  description: string;
  title: string;
}[] {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch (e) {
    return [
      {
        guid: "",
        imageUrl: "",
        description: "",
        title: "",
      },
    ];
  }
}

function getCacheForGuid(guid: string): {
  guid: string;
  imageUrl: string;
  description: string;
  title: string;
} | null {
  const cache = getCache();
  const idx = cache.findIndex((c) => c.guid === guid);
  if (idx >= 0) {
    return cache[idx];
  }
  return null;
}

function setCache(
  guid: string,
  imageUrl: string,
  title: string,
  description: string,
) {
  const cache = getCache();
  const idx = cache.findIndex((c) => c.guid === guid);
  if (idx >= 0) {
    cache[idx] = {
      guid,
      title,
      imageUrl,
      description,
    };
  } else {
    cache.push({
      guid,
      imageUrl,
      title,
      description,
    });
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// Helper to add CORS headers
function withCors(original: Response): Response {
  // Copy status and statusText
  const newHeaders = new Headers(original.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  // Clone original response with new headers
  return new Response(original.body, {
    status: original.status,
    statusText: original.statusText,
    headers: newHeaders,
  });
}

serve({
  port: process.env.PORT || 3000,
  routes: {
    "/article": async (req) => {
      const url = new URL(req.url);
      const guid = url.searchParams.get("guid");

      if (!guid) {
        return new Response("No image specified", { status: 400 });
      }

      const cache = getCacheForGuid(guid);

      if (!cache) {
        return new Response("No image found", { status: 404 });
      }

      const res = new Response(`
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
      `);

      res.headers.set("content-type", "text/html");

      return withCors(res);
    },
    "/": async (req) => {
      const url = new URL(req.url);
      const feed = url.searchParams.get("feed");

      if (!feed) {
        return new Response("No feed specified", { status: 400 });
      }

      const parser: Parser = new Parser();
      const inFeed = await parser.parseURL(feed);

      const outFeed = new RSS({
        title: inFeed.title!,
        description: inFeed.description,
        feed_url: inFeed.feedUrl!,
        site_url: inFeed.feedUrl!,
        language: "en",
      });

      const proms = [] as Promise<void>[];

      // only keeping the 10 most recent items
      inFeed.items.sort((a, b) => {
        return Date.parse(b.pubDate!) - Date.parse(a.pubDate!);
      });
      inFeed.items = inFeed.items.slice(0, 10);

      for (const item of inFeed.items) {
        const p = new Promise<{
          title: string;
          description: string;
          url: string;
          guid: string;
          enclosure: { url: string };
          date: string;
        }>(async (resolve, reject) => {
          // Following the link
          const res = await fetch(item.link!).then((res) => res.text());

          // Parse the HTML
          const root = parse(res);

          const elems = root.querySelectorAll("img[src]");
          if (elems.length === 0) {
            reject();
          }

          // Downloading all the images, and finding the biggest one
          const imgs = await Promise.all(
            elems.map(async (elem) => {
              const imageUrl = elem.getAttribute("src");
              if (!imageUrl || !/.(jpg|png)$/.test(imageUrl)) {
                return { url: "", blob: null };
              }
              const res = await fetch(imageUrl).then((res) => res.bytes());
              return { url: imageUrl, blob: res };
            }),
          );

          let biggest = {
            size: 0,
            url: "",
          };
          for (const img of imgs) {
            if (!img.blob) continue;

            const size = imageSize(img.blob);
            if (size.width * size.height > biggest.size) {
              biggest = {
                size: size.width * size.height,
                url: img.url,
              };
            }
          }

          if (biggest.size === 0) {
            return reject();
          }

          setCache(item.guid!, biggest.url, item.title!, item.description);

          resolve({
            title: item.title!,
            description: item.description,
            url: `${HOST}:8033/article?guid=${encodeURIComponent(item.guid!)}`,
            guid: item.guid!,
            enclosure: { url: biggest.url },
            date: item.pubDate!,
          });
        });

        proms.push(
          p.then((res) => {
            outFeed.item(res);
          }),
        );
      }

      await Promise.all(proms);
      return new Response(outFeed.xml());
    },
  },
});
