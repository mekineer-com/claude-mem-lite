// stop-words.mjs — Shared base stop-word set for all NLP/search modules.
// Single source of truth: consumers extend with domain-specific extras.

/** Common English stop words shared across FTS, TF-IDF, PRF, and registry search. */
export const BASE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'after', 'before', 'above', 'below', 'and', 'or', 'but', 'not', 'no',
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'his',
  'her', 'our', 'their', 'me', 'him', 'us', 'them', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'also', 'then', 'so', 'if',
]);
