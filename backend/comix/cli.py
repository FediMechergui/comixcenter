"""
Command line: python -m comix <command>

  serve [--lan] [--port P]      run the API + worker (+ web app if built); --lan lets phones on your Wi-Fi connect
  migrate                       apply database migrations and seed the taxonomy
  status                        show configuration and catalog counts
  sync <kind> <metron_id>       queue a Metron sync (series|issue|arc|character|team|reading_list)
  find-series <name> [year]     look a series up on Metron and sync the best match
  run-jobs [--limit N]          process queued jobs in the foreground
  scan [folder ...]             import comics you own from folders (default: COMIX_SCAN_DIRS)
"""
import argparse
import json
import sys
from pathlib import Path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="comix", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--lan", action="store_true", help="listen on all interfaces so phones on your network can connect")
    serve.add_argument("--port", type=int, default=8000)
    sub.add_parser("migrate")
    sub.add_parser("status")
    sync = sub.add_parser("sync")
    sync.add_argument("kind", choices=["series", "issue", "arc", "character", "team", "reading_list", "publishers"])
    sync.add_argument("metron_id", type=int, nargs="?")
    sync.add_argument("--shallow", action="store_true", help="skip per-issue detail")
    find = sub.add_parser("find-series")
    find.add_argument("name")
    find.add_argument("year", type=int, nargs="?")
    run = sub.add_parser("run-jobs")
    run.add_argument("--limit", type=int)
    scan = sub.add_parser("scan")
    scan.add_argument("folders", nargs="*")
    args = parser.parse_args(argv)

    from comix.bootstrap import bootstrap
    from comix.config import get_settings
    from comix.db import session_scope, upgrade_database

    if args.command == "serve":
        import uvicorn
        from comix.api.app import create_app
        from comix.network import lan_addresses
        host = "0.0.0.0" if args.lan else args.host
        if host not in ("127.0.0.1", "localhost"):
            urls = [f"http://{ip}:{args.port}" for ip in lan_addresses()]
            print("ComixCenter is reachable from your network at:", ", ".join(urls) or "(no network address found)", flush=True)
            print("Enter one of these in the Android app under Settings > Server.", flush=True)
            if not get_settings().admin_token:
                print("WARNING: ADMIN_TOKEN is not set, so anyone on this network can use the curation tools. "
                      "Set ADMIN_TOKEN in backend/.env and enter it in the app's Settings.", flush=True)
        uvicorn.run(create_app(), host=host, port=args.port)
        return 0

    upgrade_database()
    with session_scope() as session:
        created = bootstrap(session)

    if args.command == "migrate":
        print(f"Database ready at {get_settings().database_url}; seeded {created}")
    elif args.command == "status":
        from comix.api.app import create_app
        from fastapi.testclient import TestClient
        with TestClient(create_app(start_worker=False)) as client:
            print(json.dumps(client.get("/api/status").json(), indent=2))
    elif args.command in ("sync", "find-series"):
        from comix.ingest.jobs import enqueue
        with session_scope() as session:
            if args.command == "find-series":
                job = enqueue(session, "metron.find_series", {"name": args.name, "year": args.year, "deep": True})
            elif args.kind == "publishers":
                job = enqueue(session, "metron.publishers", {})
            else:
                payload = {"metron_id": args.metron_id}
                if args.kind in ("series", "arc"):
                    payload["deep"] = not args.shallow
                job = enqueue(session, f"metron.{args.kind}", payload)
            print(f"Queued job {job.id} ({job.kind}); run `python -m comix run-jobs` or start the server")
    elif args.command == "run-jobs":
        from comix.ingest.jobs import run_pending
        print(f"Ran {run_pending(args.limit)} job(s)")
    elif args.command == "scan":
        from comix.library.importer import scan_directories
        folders = [Path(f) for f in args.folders] or get_settings().scan_dirs
        if not folders:
            print("No folders given and COMIX_SCAN_DIRS is not set", file=sys.stderr)
            return 2
        with session_scope() as session:
            result = scan_directories(session, folders)
        print(json.dumps({k: v for k, v in result.items() if k != "file_ids"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
