/** Source API clients (Metron, Comic Vine, Grand Comics Database) and their HTTP plumbing. */
export {
  USER_AGENT, NetworkError, buildUrl, cacheKey, createNativeHttp, createFetchHttp, realClock, Pacer, formatSeconds,
  parseRetryAfter, pacedRequest, cachedGet, MemoryCache, base64Utf8,
} from "./http";
export type { Clock, PacerOptions, PacedRequestOptions, SourceTestResult } from "./http";

export {
  METRON_API, METRON_MIN_INTERVAL_MS, createMetronClient, createMetronPacer, metronAuthHeader, testMetron,
} from "./metron";
export type {
  MetronAuth, MetronClient, MetronClientOptions, MetronParams, MetronRateLimitStatus, MetronGenericItem,
  MetronResource, MetronPublisher, MetronUniverse, MetronSeries, MetronSeriesListItem, MetronAssociatedSeries,
  MetronBasicSeries, MetronIssueListItem, MetronIssueSeries, MetronIssue, MetronCredit, MetronReprint, MetronVariant,
  MetronArc, MetronCharacter, MetronTeam, MetronUser, MetronReadingList, MetronReadingListListItem,
  MetronReadingListIssue, MetronReadingListItem, MetronReadingListNav,
} from "./metron";

export {
  COMICVINE_API, COMICVINE_MIN_INTERVAL_MS, CV_RESOURCES, createComicVineClient, createComicVinePacer,
  comicVineError, parseCvBirth, testComicVine,
} from "./comicvine";
export type {
  ComicVineClient, ComicVineClientOptions, CvEntry, CvIssueEntry, CvCreatorEntry, CvCountEntry, CvImages,
  CvAssociatedImage, CvBasicCharacter, CvCharacter, CvBasicIssue, CvIssue, CvBasicTeam, CvTeam, CvBasicStoryArc,
  CvStoryArc, CvBasicVolume, CvVolume,
} from "./comicvine";

export {
  GCD_API, GCD_MIN_INTERVAL_MS, GCD_TTL, createGcdClient, createGcdPacer, gcdIdFromUrl, gcdKeyDateToDate,
  mapGcdIssue, mapGcdSeries, mapGcdPublisher, splitTopLevel, parseGcdCredits, parseGcdCreditEntries,
  parseGcdCharacters, flattenGcdCharacters,
} from "./gcd";
export type {
  GcdClient, GcdClientOptions, GcdIssue, GcdStory, GcdSeries, GcdPublisher, GcdPage, GcdCredit, GcdCharacter, GcdRole,
} from "./gcd";
