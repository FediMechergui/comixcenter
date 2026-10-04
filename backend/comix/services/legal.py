"""
"Where to read legally" links for issues the user doesn't own. These are search links into
each service (which change their URL schemes rarely); Kindle covers most collected editions.
"""
from typing import Dict, List, Optional
from urllib.parse import quote_plus


def legal_links(series_name: str, number: Optional[str], year: Optional[int], publisher_slug: Optional[str],
                is_collection: bool = False) -> List[Dict[str, str]]:
    label = series_name + (f" ({year})" if year else "")
    query = f"{series_name} #{number}" if number and not is_collection else series_name
    links: List[Dict[str, str]] = []
    if publisher_slug == "marvel":
        links.append({"service": "Marvel Unlimited", "kind": "subscription",
                      "url": f"https://www.marvel.com/search?limit=20&query={quote_plus(query)}&offset=0&content_type=comics"})
    if publisher_slug == "dc":
        links.append({"service": "DC Universe Infinite", "kind": "subscription",
                      "url": f"https://www.google.com/search?q={quote_plus(f'site:dcuniverseinfinite.com {query}')}"})
    links.append({"service": "Kindle / comiXology", "kind": "buy",
                  "url": f"https://www.amazon.com/s?k={quote_plus(label + (f' {number}' if number else ''))}&i=digital-text"})
    links.append({"service": "Your local library (Libby / hoopla)", "kind": "library",
                  "url": f"https://www.google.com/search?q={quote_plus(query + ' comic libby OR hoopla')}"})
    return links
