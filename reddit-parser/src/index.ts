import Parser from "rss-parser";
import { parse } from "node-html-parser";
import RSS from "rss";
import { serve } from "bun";

serve({
  port: process.env.PORT || 3000,
  routes: {
    "/": async (req) => {
      const url = new URL(req.url);
      const sub = url.searchParams.get("sub");

      if (!sub) {
        return new Response("No sub specified", { status: 400 });
      }

      const parser: Parser = new Parser();
      const inFeed = await parser.parseURL(
        `https://www.reddit.com/r/${sub}.rss`,
      );

      const outFeed = new RSS({
        title: inFeed.title!,
        description: inFeed.description,
        feed_url: inFeed.feedUrl!,
        site_url: inFeed.feedUrl!,
        language: "en",
      });

      const proms = [] as Promise<void>[];

      for (const item of inFeed.items) {
        const p = new Promise<{
          title: string;
          description: string;
          url: string;
          date: string;
        }>(async (resolve, reject) => {
          // Following the link
          const res = await fetch(item.link!).then((res) => res.text());

          // Parse the HTML
          const root = parse(res);

          const elem = root.querySelector(
            "faceplate-tracker[source=post_lightbox] a",
          );
          if (elem) {
            resolve({
              title: item.title!,
              description: item.description,
              url: elem.getAttribute("href")!,
              date: item.pubDate!,
            });
          } else {
            resolve({
              title: item.title!,
              description: item.description,
              url: item.link!,
              date: item.pubDate!,
            });
          }
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
