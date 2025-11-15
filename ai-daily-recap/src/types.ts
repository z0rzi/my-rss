/**
 * Reference to an original article from an RSS feed.
 * Contains all necessary metadata to link back to source content.
 */
export type ArticleReference = {
  /** Original article title */
  title: string;
  /** URL to original article */
  link: string;
  /** Article description/excerpt */
  description: string;
  /** ISO 8601 date string */
  pubDate: string;
};

/**
 * AI-generated recap for a single day's worth of articles.
 * Contains the generated html summary and references to source articles.
 */
export type DailyRecap = {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** LLM-generated recap in html format */
  html: string;
  /** Source articles used to generate this recap */
  articles: ArticleReference[];
};

/**
 * Root storage structure for the entire application.
 * Contains all tracked feeds and their associated recaps.
 */
export type Storage = {
  [feedUrl: string]: DailyRecap[];
};
