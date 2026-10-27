"""Start the ebusd Config Workbench backend: python3 -m workbench [options]."""

import argparse
import logging
import os
import signal
import sys
import threading

from . import __version__
from .db import Database
from .gitrepo import Repo, RepoError
from .ha import HAClient
from .server import Context, make_server
from .settings import Settings

log = logging.getLogger("workbench")


def parse_args(argv=None):
    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(env("WORKBENCH_PORT", "8099")))
    parser.add_argument("--bind", default=env("WORKBENCH_BIND", "0.0.0.0"))
    parser.add_argument("--db", default=env("WORKBENCH_DB", "/share/ebusd/telegrams.db"), help="SQLite telegram log")
    parser.add_argument("--repo", default=env("WORKBENCH_REPO_DIR", "/config/repo"), help="git checkout of the definitions")
    parser.add_argument("--repo-url", default=env("WORKBENCH_REPO_URL", ""), help="clone this URL if the checkout is missing")
    parser.add_argument("--deploy", default=env("WORKBENCH_DEPLOY_PATH", "/share/ebusd/config"), help="folder for compiled CSV files")
    parser.add_argument("--data", default=env("WORKBENCH_DATA_DIR", "/data"), help="folder for settings.json")
    parser.add_argument("--www", default=env("WORKBENCH_WWW", os.path.join(os.path.dirname(__file__), "..", "www")))
    parser.add_argument("--allow-any", action="store_true", help="accept requests from any client (development)")
    parser.add_argument("--no-ha", action="store_true", help="do not connect to Home Assistant")
    parser.add_argument("--log-level", default=env("WORKBENCH_LOG_LEVEL", "info"))
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), stream=sys.stderr,
                        format="[%(asctime)s] %(levelname)s: %(name)s: %(message)s", datefmt="%H:%M:%S")
    log.info("ebusd Config Workbench %s", __version__)

    db = Database(args.db)
    try:
        db.ensure_schema()
    except OSError as err:
        log.error("unable to open the database %s: %s", args.db, err)
    settings = Settings(os.path.join(args.data, "settings.json"))
    repo = Repo(args.repo)
    ha = None
    if not args.no_ha:
        ha = HAClient(db, settings)
        ha.start()
    if args.repo_url and not repo.exists():
        def clone():
            try:
                log.info("cloning %s into %s", args.repo_url, args.repo)
                repo.clone(args.repo_url)
                log.info("cloned %s", args.repo_url)
            except RepoError as err:
                log.error("unable to clone %s: %s", args.repo_url, err)
        threading.Thread(target=clone, name="clone", daemon=True).start()

    ctx = Context(db, settings, repo, ha=ha, deploy_dir=args.deploy, www_dir=os.path.abspath(args.www),
                  allow_any=args.allow_any)
    server = make_server(ctx, args.bind, args.port)
    log.info("listening on %s:%d (database %s, repository %s, deploy folder %s)", args.bind, args.port, args.db,
             args.repo, args.deploy)

    def stop(*_):
        log.info("shutting down")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if ha:
            ha.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
