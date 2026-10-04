# Source client fixtures

## gcd/ — real responses

Fetched from the public Grand Comics Database API (`https://www.comics.org/api/…?format=json`,
User-Agent `ComixCenter/0.1 (personal comic reader app)`) on 2026-10-04, saved unmodified:

| File | Request |
| --- | --- |
| `series_name_asm_1963.json` | `series/name/Amazing Spider-Man/year/1963/` |
| `series_name_xmen_1963.json` | `series/name/X-Men/year/1963/` |
| `series_name_hox_2019.json` | `series/name/House of X/year/2019/` (3 substring matches) |
| `series_name_ntt_1980.json` | `series/name/The New Teen Titans/year/1980/` |
| `issue_44451.json` | Amazing Spider-Man #300 [Direct] (Venom) |
| `issue_27163.json` | Amazing Spider-Man #129 (Punisher) |
| `issue_19164.json` | Avengers #16 (team rosters, joins/leaves) |
| `issue_45864.json` | Avengers #300 [Direct] |
| `issue_34709.json` | X-Men #137 [Direct] (Phoenix death) |
| `issue_34826.json` | New Teen Titans #1 [Direct] |
| `issue_724.json` | Batman #1 (1940) |
| `issue_26595.json` | Batman #251 |
| `issue_69630.json` | Witchblade #2 |
| `issue_1998963.json` | House of X #1 |
| `throttled_429.json` | body of the HTTP 429 (`Retry-After: 2895`) GCD returned after ~14 requests |

The publisher detail/list shapes used in `gcd.test.ts` are inline and minimal: the throttle hit
before a publisher endpoint was fetched.

## metron/ and comicvine/ — synthesized, not captured

No Metron credentials or Comic Vine API key were available, so these files were **written by hand**
(generator scripts, not live calls) to match the JSON the APIs send *before* alias resolution, as
derived from the client libraries the backend uses:

- Metron: mokkari's pydantic schemas (`mokkari/schemas/*.py`) — e.g. issue lists send `issue`
  (→ `issue_name`), series lists send `series` (→ `display_name`), issue detail sends `title`,
  `name`, `page` (→ `collection_title`, `story_titles`, `page_count`); `{"detail": …}` error bodies
  as Django REST framework sends them.
- Comic Vine: simyan's schemas (`simyan/schemas/*.py`) and its error handling — e.g.
  `issues_died_in`, `first_appeared_in_issue`, team `characters`, `disbanded_in_issues`,
  `count_of_isssue_appearances` (CV's own typo), `deck`, `issue_number`, `api_detail_url`, image
  `thumb_url`/`screen_large_url`, `status_code` 100/101/107 envelopes.

Values (ids, names, dates) are plausible but not guaranteed to match the live databases.
