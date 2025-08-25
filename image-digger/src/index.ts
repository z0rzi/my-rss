import Parser from "rss-parser";
import { parse } from "node-html-parser";
import RSS from "rss";
import { serve } from "bun";
import { imageSize } from "image-size";

serve({
  port: process.env.PORT || 3000,
  routes: {
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

          resolve({
            title: item.title!,
            description: item.description,
            url: biggest.url,
            guid: biggest.url,
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
