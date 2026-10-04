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

def inspect_getcomics_details():
    print("=" * 60)
    print("1. DEEP INSPECT GETCOMICS: CATEGORIES & DOWNLOAD LINKS")
    print("=" * 60)
    
    # Check Categories
    cats_url = "https://getcomics.org/wp-json/wp/v2/categories?per_page=50"
    try:
        req = urllib.request.Request(cats_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            cats = json.loads(resp.read().decode('utf-8'))
            print(f"[+] Found {len(cats)} categories on GetComics:")
            for c in cats:
                print(f"    - ID: {c['id']:<4} | Slug: {c['slug']:<18} | Name: {c['name']} (Count: {c['count']})")
    except Exception as e:
        print(f"[-] Categories probe failed: {e}")

    # Inspect a post's content for download link patterns
    post_url = "https://getcomics.org/wp-json/wp/v2/posts?per_page=1"
    try:
        req = urllib.request.Request(post_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            posts = json.loads(resp.read().decode('utf-8'))
            if posts:
                post = posts[0]
                print(f"\n[+] Analyzing Post #{post['id']}: {post['title']['rendered']}")
                content = post['content']['rendered']
                
                # Extract all <a> hrefs and text
                links = re.findall(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', content, re.IGNORECASE)
                print(f"    Extracted {len(links)} links from content body:")
                for href, text in links:
                    clean_text = re.sub(r'<[^>]+>', '', text).strip()
                    if clean_text:
                        print(f"      [{clean_text}]: {href[:90]}")
    except Exception as e:
        print(f"[-] Post content probe failed: {e}")

def inspect_rco_stream():
    print("\n" + "=" * 60)
    print("2. DEEP INSPECT READCOMICSONLINE: ISSUE PAGES & CDN STREAM")
    print("=" * 60)
    
    issue_url = "https://readcomicsonline.ru/comic/xmen-2024/1"
    print(f"[*] Fetching issue page: {issue_url}")
    try:
        req = urllib.request.Request(issue_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            
            # Find all page images inside #reader-all or chapters
            img_urls = re.findall(r'src="(https://cdn\.readcomicsonline\.ru/uploads/manga/[^"]+\.jpg[^"]*)"', html)
            print(f"[+] Extracted {len(img_urls)} page image URLs for X-Men (2024-) #1!")
            if img_urls:
                first_page = img_urls[0]
                print(f"    First page: {first_page}")
                print(f"    Last page:  {img_urls[-1]}")
                
                # Now test streaming/downloading byte sample from CDN with Referer
                cdn_headers = {
                    'User-Agent': HEADERS['User-Agent'],
                    'Referer': issue_url,
                }
                print(f"[*] Testing CDN download for {first_page}...")
                img_req = urllib.request.Request(first_page, headers=cdn_headers)
                with urllib.request.urlopen(img_req, context=ctx, timeout=10) as img_resp:
                    img_bytes = img_resp.read(1024) # first 1KB
                    print(f"[+] CDN STREAM SUCCESS! Status: {img_resp.status}, Content-Type: {img_resp.headers.get('Content-Type')}, Bytes read: {len(img_bytes)}")
                    print(f"    Header Magic Bytes: {img_bytes[:4]}")
    except Exception as e:
        print(f"[-] RCO stream probe failed: {e}")

def inspect_batcave():
    print("\n" + "=" * 60)
    print("3. DEEP INSPECT BATCAVE: CLOUDFLARE ANALYSIS")
    print("=" * 60)
    
    # Try with various User-Agents and examine response headers
    try:
        req = urllib.request.Request("https://batcave.biz", headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            print(f"[+] Connected to Batcave! Status: {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"[-] HTTP Error {e.code}")
        print("    Response Headers:")
        for k, v in e.headers.items():
            if k.lower() in ['server', 'cf-ray', 'cf-mitigated', 'content-type', 'set-cookie']:
                print(f"      {k}: {v}")
    except Exception as e:
        print(f"[-] Batcave failed: {e}")

if __name__ == '__main__':
    inspect_getcomics_details()
    inspect_rco_stream()
    inspect_batcave()
