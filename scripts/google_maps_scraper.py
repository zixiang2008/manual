#!/usr/bin/env python3
"""Google Maps place metadata collector using Playwright or Apify.

MIT License. Use only for places you are entitled to process, at a modest rate,
and review Google Maps' current terms before production use. The Playwright path
does not bypass login, consent, CAPTCHA, or other access controls.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus


MAPS_BASE = "https://www.google.com/maps"
PHOTO_HOSTS = ("googleusercontent.com", "ggpht.com")


def browser_launch_options(headless: bool) -> dict[str, Any]:
    """Use bundled Chromium when available, otherwise a locally installed Chrome."""
    options: dict[str, Any] = {"headless": headless}
    configured = os.environ.get("PLAYWRIGHT_CHROME_PATH")
    candidates = [
        configured,
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            options["executable_path"] = candidate
            break
    return options


def compact(value: str | None) -> str | None:
    text = re.sub(r"[\ue000-\uf8ff]", "", value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def strip_label(value: str | None, labels: tuple[str, ...]) -> str | None:
    text = compact(value)
    if not text:
        return None
    for label in labels:
        text = re.sub(rf"^{re.escape(label)}\s*[:：]?\s*", "", text, flags=re.I)
    return compact(text)


def high_resolution_photo(url: str) -> str:
    if not url or not any(host in url for host in PHOTO_HOSTS):
        return url
    return re.sub(r"=w\d+(?:-h\d+)?(?:-[a-z0-9]+)*$", "=w1600-h1200-no", url)


async def first_text(page, selectors: list[str]) -> str | None:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if await locator.count() and await locator.is_visible():
                return compact(await locator.inner_text())
        except Exception:
            continue
    return None


async def first_attr(page, selectors: list[str], attribute: str) -> str | None:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if await locator.count():
                value = await locator.get_attribute(attribute)
                if value:
                    return compact(value)
        except Exception:
            continue
    return None


async def accept_consent(page) -> None:
    for label in ("Accept all", "I agree", "Reject all", "全部接受", "我同意", "ยอมรับทั้งหมด"):
        try:
            button = page.get_by_role("button", name=re.compile(f"^{re.escape(label)}$", re.I)).first
            if await button.count() and await button.is_visible():
                await button.click(timeout=2500)
                await page.wait_for_timeout(800)
                return
        except Exception:
            continue


async def opening_hours(page) -> list[str]:
    selectors = [
        '[jsaction*="openhours"][jsaction*="dropdown"]',
        'button[data-item-id*="oh"]',
        'button[aria-label*="营业时间"]',
        'button[aria-label*="Hours"]',
        'button[aria-label*="เวลาทำการ"]',
        'div[aria-label*="Hours"] button',
        'div[aria-label*="营业时间"] button',
        'div[aria-label*="เวลาทำการ"] button',
    ]
    for selector in selectors:
        button = page.locator(selector).first
        try:
            if not await button.count() or not await button.is_visible():
                continue
            aria = await button.get_attribute("aria-label")
            await button.click(timeout=3000)
            await page.wait_for_timeout(500)
            rows = page.locator('table tr, div[role="dialog"] tr')
            values: list[str] = []
            for index in range(min(await rows.count(), 14)):
                value = compact(await rows.nth(index).inner_text())
                if value and value not in values:
                    values.append(value)
            if values:
                return values
            if aria:
                return [compact(part) for part in re.split(r"[;\n]", aria) if compact(part)]
        except Exception:
            continue
    return []


async def photo_urls(page, limit: int = 3) -> list[str]:
    urls: list[str] = []
    selectors = [
        'button[jsaction*="heroHeaderImage"] img',
        'div[role="main"] img[src*="googleusercontent"]',
        'div[role="main"] img[src*="ggpht"]',
    ]
    for selector in selectors:
        locator = page.locator(selector)
        try:
            for index in range(min(await locator.count(), 30)):
                src = await locator.nth(index).get_attribute("src")
                if src and any(host in src for host in PHOTO_HOSTS):
                    src = high_resolution_photo(src)
                    if src not in urls:
                        urls.append(src)
                        if len(urls) >= limit:
                            return urls
        except Exception:
            continue
    try:
        styled = page.locator('div[role="main"] [style*="background-image"]')
        for index in range(min(await styled.count(), 40)):
            style = await styled.nth(index).get_attribute("style") or ""
            match = re.search(r'url\(["\']?(https?://[^)"\']+)', style)
            if match and any(host in match.group(1) for host in PHOTO_HOSTS):
                src = high_resolution_photo(match.group(1))
                if src not in urls:
                    urls.append(src)
                    if len(urls) >= limit:
                        break
    except Exception:
        pass
    return urls


async def extract_place(page, source_url: str | None = None) -> dict[str, Any]:
    await page.wait_for_selector('h1, div[role="main"]', timeout=15000)
    name = await first_text(page, ['h1.DUwDvf', 'h1', 'div[role="main"] h1'])
    address = strip_label(
        await first_attr(page, ['button[data-item-id="address"]'], "aria-label")
        or await first_text(page, ['button[data-item-id="address"]']),
        ("Address", "地址", "ที่อยู่"),
    )
    phone = strip_label(
        await first_attr(page, ['button[data-item-id^="phone:tel:"]', 'button[data-item-id*="phone"]'], "aria-label")
        or await first_text(page, ['button[data-item-id^="phone:tel:"]']),
        ("Phone", "电话", "電話", "โทรศัพท์"),
    )
    website = await first_attr(page, ['a[data-item-id="authority"]', 'a[data-item-id*="authority"]'], "href")
    category = await first_text(page, ['button[jsaction*="category"]', 'div[role="main"] button.DkEaL'])
    return {
        "name": name,
        "address": address,
        "phone": phone,
        "website": website,
        "category": category,
        "openingHours": await opening_hours(page),
        "photos": await photo_urls(page),
        "googleMapsUrl": page.url or source_url,
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
    }


async def result_links(page, max_results: int) -> list[str]:
    feed = page.locator('div[role="feed"]')
    if not await feed.count():
        return []
    for _ in range(8):
        links = page.locator('div[role="feed"] a[href*="/maps/place/"]')
        if await links.count() >= max_results:
            break
        try:
            await feed.evaluate("element => element.scrollBy(0, element.scrollHeight)", timeout=1500)
        except Exception:
            await page.mouse.wheel(0, 1600)
        await page.wait_for_timeout(700)
    output: list[str] = []
    links = page.locator('div[role="feed"] a[href*="/maps/place/"]')
    for index in range(min(await links.count(), max_results * 3)):
        href = await links.nth(index).get_attribute("href")
        if href and href not in output:
            output.append(href)
            if len(output) >= max_results:
                break
    return output


def write_cache(output: Path, provider: str, items: dict[str, Any]) -> None:
    payload = {"generatedAt": datetime.now(timezone.utc).isoformat(), "provider": provider, "items": items}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)


async def scrape_playwright(targets: list[dict[str, str]], headless: bool, delay: float, output: Path, existing: dict[str, Any]) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as error:
        raise SystemExit("Install dependencies: pip install -r requirements-scraper.txt && playwright install chromium") from error

    results: dict[str, Any] = dict(existing)
    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(headless=headless)
        except Exception as bundled_error:
            options = browser_launch_options(headless)
            if "executable_path" not in options:
                raise RuntimeError(
                    "Chromium is unavailable. Run 'playwright install chromium' or set PLAYWRIGHT_CHROME_PATH."
                ) from bundled_error
            browser = await playwright.chromium.launch(**options)
        context = await browser.new_context(locale="zh-CN", timezone_id="Asia/Bangkok", viewport={"width": 1440, "height": 1000})
        page = await context.new_page()
        for index, target in enumerate(targets, start=1):
            key, query, url = target["id"], target.get("query", ""), target.get("url", "")
            if key in results and not results[key].get("error"):
                print(f"[{index}/{len(targets)}] {key}: cached", file=sys.stderr)
                continue
            destination = url or f"{MAPS_BASE}/search/{quote_plus(query)}?hl=zh-CN"
            try:
                await page.goto(destination, wait_until="domcontentloaded", timeout=45000)
                await accept_consent(page)
                await page.wait_for_timeout(1800)
                has_place_heading = await page.locator('h1').count()
                if not has_place_heading and ("/maps/search/" in page.url or await page.locator('div[role="feed"]').count()):
                    links = await result_links(page, 1)
                    if not links:
                        raise RuntimeError("No Google Maps result card found")
                    await page.goto(links[0], wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(1000)
                results[key] = await extract_place(page, destination)
                print(f"[{index}/{len(targets)}] {key}: {results[key].get('name') or 'unnamed'}", file=sys.stderr)
            except Exception as error:
                results[key] = {"error": str(error), "googleMapsUrl": destination, "scrapedAt": datetime.now(timezone.utc).isoformat()}
                print(f"[{index}/{len(targets)}] {key}: ERROR {error}", file=sys.stderr)
            write_cache(output, "playwright", results)
            if index < len(targets):
                await asyncio.sleep(delay + random.uniform(0.2, 0.8))
        await browser.close()
    return results


def scrape_apify(targets: list[dict[str, str]], max_results: int) -> dict[str, Any]:
    token = os.environ.get("APIFY_API_TOKEN")
    if not token:
        raise SystemExit("APIFY_API_TOKEN is required for --provider apify")
    try:
        from apify_client import ApifyClient
    except ImportError as error:
        raise SystemExit("Install dependencies: pip install -r requirements-scraper.txt") from error
    client = ApifyClient(token)
    searches = [target.get("query") or target.get("url") for target in targets]
    actor_call = client.actor("apify/google-maps-scraper").call(run_input={"searchStringsArray": searches, "maxCrawledPlacesPerSearch": max_results, "language": "zh"})
    rows = list(client.dataset(actor_call["defaultDatasetId"]).iterate_items())
    results: dict[str, Any] = {}
    for target, row in zip(targets, rows):
        results[target["id"]] = {
            "name": row.get("title"), "address": row.get("address"), "phone": row.get("phone"),
            "website": row.get("website"), "openingHours": row.get("openingHours") or [],
            "photos": [photo.get("imageUrl") if isinstance(photo, dict) else photo for photo in (row.get("imageUrls") or row.get("images") or [])][:3],
            "googleMapsUrl": row.get("url") or target.get("url"), "placeId": row.get("placeId"),
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
        }
    return results


def load_targets(args: argparse.Namespace) -> list[dict[str, str]]:
    if args.input:
        data = json.loads(Path(args.input).read_text(encoding="utf-8"))
        targets = []
        for item in data.get("items", []):
            maps = item.get("maps") or []
            source_url = maps[0] if maps else ""
            # Short share links can stall in headless mode; search by the normalized name instead.
            direct_url = source_url if "google.com/maps" in source_url else ""
            targets.append({"id": item["id"], "query": f"{item.get('displayName') or item.get('name')} Chiang Mai Thailand", "url": direct_url})
        return targets[: args.max_results] if args.max_results else targets
    if not args.query and not args.url:
        raise SystemExit("Provide --query, --url, or --input")
    return [{"id": args.id or "result-1", "query": args.query or "", "url": args.url or ""}]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect Google Maps place details into JSON")
    parser.add_argument("--query", help="One Google Maps search query")
    parser.add_argument("--url", help="One Google Maps place/share URL")
    parser.add_argument("--id", help="Stable id for a single result")
    parser.add_argument("--input", help="places.json; processes each item")
    parser.add_argument("--output", default="data/google-maps-cache.json")
    parser.add_argument("--provider", choices=("playwright", "apify"), default="playwright")
    parser.add_argument("--max-results", type=int, default=0, help="Limit input items; 0 means all")
    parser.add_argument("--delay", type=float, default=2.5, help="Seconds between Playwright place visits")
    parser.add_argument("--headed", action="store_true", help="Show Chromium for debugging")
    parser.add_argument("--resume", action="store_true", help="Keep successful rows already present in --output")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    targets = load_targets(args)
    output = Path(args.output)
    existing: dict[str, Any] = {}
    if args.resume and output.exists():
        try:
            existing = json.loads(output.read_text(encoding="utf-8")).get("items", {})
        except Exception:
            existing = {}
    if args.provider == "apify":
        items = scrape_apify(targets, 1)
    else:
        items = asyncio.run(scrape_playwright(targets, headless=not args.headed, delay=max(args.delay, 1.0), output=output, existing=existing))
    write_cache(output, args.provider, items)
    print(json.dumps({"output": str(output), "items": len(items), "errors": sum(1 for item in items.values() if item.get("error"))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
