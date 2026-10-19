"""The same reading endpoints used by device and server clients."""
from fastapi import APIRouter, HTTPException, Query, Response
import httpx
import os
from comix.services.online import online_reader

router = APIRouter(prefix="/api/online", tags=["online reader"])


async def result(operation):
    try:
        return await operation
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Batcave: {exc}") from exc


@router.get("/catalog")
async def catalog(q: str = Query(default="", max_length=150), page: int = Query(default=1, ge=1, le=1000), source: str = "auto"):
    if source == "batcave":
        return await result(online_reader.catalog(q, page))
    if source not in ("auto", "getcomics"):
        raise HTTPException(422, "Choose auto, batcave or getcomics")
    try:
        gateway = os.getenv("COMIX_GATEWAY_URL", "https://comixcenter-gateway.vercel.app").rstrip("/")
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(gateway + "/api/online/catalog", params={"q": q, "page": page, "source": source})
        if not response.is_success:
            raise HTTPException(response.status_code, "Online sources are unavailable. Try another source.")
        return response.json()
    except httpx.HTTPError:
        raise HTTPException(504, "The source gateway did not answer. Your local catalog is still available.") from None


@router.get("/read/chapters")
async def chapters(url: str):
    return await result(online_reader.chapters(url))


@router.get("/cover")
async def cover(url: str):
    content = await result(online_reader.cover(url))
    return Response(content=content, media_type="image/webp" if content[:4] == b"RIFF" else "image/png" if content[:4] == b"\x89PNG" else "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800"})


@router.get("/read/pages")
async def pages(url: str, chapter: str):
    return await result(online_reader.pages(url, chapter))


@router.get("/read/page")
async def image(url: str):
    return await result(online_reader.image(url))
