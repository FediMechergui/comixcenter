import urllib.request
import urllib.error
import json
import re
import ssl

ctx = ssl.create_default_context()

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
}

def test_getcomics():
    print("=" * 60)
    print("1. TESTING GETCOMICS.ORG")
    print("=" * 60)
    
    # 1. Test WordPress REST API
    wp_api_url = "https://getcomics.org/wp-json/wp/v2/posts?per_page=3"
    print(f"[*] Probing GetComics WP REST API: {wp_api_url}")
    try:
        req = urllib.request.Request(wp_api_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"[+] SUCCESS! WP REST API returned {len(data)} latest posts directly:")
            for p in data:
                title = p.get('title', {}).get('rendered', '')
                date = p.get('date', '')
                link = p.get('link', '')
                print(f"    - Title: {title}\n      Date: {date}\n      Link: {link}")
    except Exception as e:
        print(f"[-] WP REST API failed: {e}")

    # 2. Test RSS Feed
    rss_url = "https://getcomics.org/feed/"
    print(f"\n[*] Probing GetComics RSS Feed: {rss_url}")
    try:
        req = urllib.request.Request(rss_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            items = re.findall(r'<item>(.*?)</item>', content, re.DOTALL)
            print(f"[+] SUCCESS! RSS Feed returned {len(items)} items in feed:")
            for item in items[:3]:
                title = re.search(r'<title>(.*?)</title>', item)
                pubdate = re.search(r'<pubDate>(.*?)</pubDate>', item)
                link = re.search(r'<link>(.*?)</link>', item)
                t_str = title.group(1) if title else "N/A"
                d_str = pubdate.group(1) if pubdate else "N/A"
                l_str = link.group(1) if link else "N/A"
                print(f"    - Title: {t_str}\n      PubDate: {d_str}\n      Link: {l_str}")
    except Exception as e:
        print(f"[-] RSS Feed failed: {e}")

def test_readcomicsonline():
    print("\n" + "=" * 60)
    print("2. TESTING READCOMICSONLINE.RU")
    print("=" * 60)

    # 1. Test RSS feed
    rss_url = "https://readcomicsonline.ru/feed"
    print(f"[*] Probing RCO RSS Feed: {rss_url}")
    try:
        req = urllib.request.Request(rss_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            items = re.findall(r'<item>(.*?)</item>', content, re.DOTALL)
            print(f"[+] SUCCESS! RCO RSS feed returned {len(items)} items:")
            for item in items[:3]:
                title = re.search(r'<title>(.*?)</title>', item)
                link = re.search(r'<link>(.*?)</link>', item)
                pubdate = re.search(r'<pubDate>(.*?)</pubDate>', item)
                print(f"    - Title: {title.group(1) if title else 'N/A'}")
                print(f"      Link: {link.group(1) if link else 'N/A'}")
                print(f"      Date: {pubdate.group(1) if pubdate else 'N/A'}")
    except Exception as e:
        print(f"[-] RCO RSS Feed failed: {e}")

    # 2. Test Latest Release page
    latest_url = "https://readcomicsonline.ru/latest-release"
    print(f"\n[*] Probing RCO Latest Releases page: {latest_url}")
    try:
        req = urllib.request.Request(latest_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            # Extract comic links
            comics = re.findall(r'href="(https://readcomicsonline\.ru/comic/[^"]+)"[^>]*>(.*?)</a>', html)
            print(f"[+] SUCCESS! Found comic links on latest-release: sample {len(comics)} links")
            seen = set()
            count = 0
            for link, text in comics:
                if link not in seen and '/comic/' in link and len(text.strip()) > 2 and '<img' not in text:
                    seen.add(link)
                    print(f"    - {text.strip()} -> {link}")
                    count += 1
                    if count >= 3:
                        break
    except Exception as e:
        print(f"[-] RCO Latest Releases failed: {e}")

def test_batcave():
    print("\n" + "=" * 60)
    print("3. TESTING BATCAVE.BIZ")
    print("=" * 60)
    
    urls = [
        "https://batcave.biz",
        "https://batcave.biz/feed",
        "https://batcave.biz/rss.xml",
        "https://batcave.biz/index.php"
    ]
    for url in urls:
        print(f"[*] Probing {url}...")
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
                print(f"[+] Status {resp.status} - OK!")
        except urllib.error.HTTPError as e:
            print(f"[-] HTTP Error {e.code}: {e.reason} (Server: {e.headers.get('Server', 'Unknown')})")
        except Exception as e:
            print(f"[-] Error: {e}")

if __name__ == '__main__':
    test_getcomics()
    test_readcomicsonline()
    test_batcave()
