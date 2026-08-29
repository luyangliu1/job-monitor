import json
import math
import os
import random
import time
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from jobspy import scrape_jobs


PORT = int(os.environ.get("JOBSPY_PORT", "8765"))
MAX_BODY_BYTES = 256 * 1024


def clean_value(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return clean_value(value.item())
        except (TypeError, ValueError):
            pass
    if isinstance(value, dict):
        return {str(key): clean_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_value(item) for item in value]
    return value


def nonempty(value):
    return str(value).strip() if value is not None else ""


def normalized_job(row, site):
    title = nonempty(row.get("title"))
    company = nonempty(row.get("company")) or "Unknown company"
    url = nonempty(row.get("job_url_direct")) or nonempty(row.get("job_url"))
    if not title or not url:
        return None
    location = row.get("location")
    if isinstance(location, dict):
        location = ", ".join(nonempty(location.get(key)) for key in ("city", "state", "country") if nonempty(location.get(key)))
    return clean_value({
        "name": title,
        "url": url,
        "company": company,
        "location": nonempty(location),
        "description": nonempty(row.get("description")),
        "date": row.get("date_posted"),
        "site": site,
    })


def scrape(payload):
    searches = payload.get("searches")
    if not isinstance(searches, list) or not searches:
        raise ValueError("searches must be a non-empty array")
    jitter = payload.get("linkedin_jitter_seconds", [0, 0])
    if not isinstance(jitter, list) or len(jitter) != 2:
        raise ValueError("linkedin_jitter_seconds must be [minimum, maximum]")
    jitter_min, jitter_max = (float(jitter[0]), float(jitter[1]))
    if jitter_min < 0 or jitter_max < jitter_min:
        raise ValueError("linkedin_jitter_seconds is invalid")

    jobs_by_url = {}
    diagnostics = []
    linkedin_seen = False
    for index, search in enumerate(searches):
        if not isinstance(search, dict):
            raise ValueError(f"searches[{index}] must be an object")
        site = nonempty(search.get("site")).lower()
        if site not in ("indeed", "linkedin"):
            raise ValueError(f"searches[{index}].site must be indeed or linkedin")
        if linkedin_seen and site == "linkedin" and jitter_max > 0:
            time.sleep(random.uniform(jitter_min, jitter_max))
        started = time.monotonic()
        frame = scrape_jobs(
            site_name=[site],
            search_term=nonempty(search.get("search_term")),
            location=nonempty(search.get("location")) or None,
            country_indeed=nonempty(search.get("country_indeed")) or "USA",
            results_wanted=int(search.get("results_wanted", 100)),
            hours_old=int(search.get("hours_old", 72)),
            is_remote=False,
            description_format="markdown",
            linkedin_fetch_description=False,
            proxies=payload.get("proxies") or None,
            verbose=1,
        )
        records = frame.to_dict(orient="records")
        accepted = 0
        for row in records:
            job = normalized_job(row, site)
            if job is None:
                continue
            jobs_by_url[job["url"]] = job
            accepted += 1
        diagnostics.append({
            "site": site,
            "search_term": nonempty(search.get("search_term")),
            "location": nonempty(search.get("location")),
            "returned": len(records),
            "normalized": accepted,
            "duration_seconds": round(time.monotonic() - started, 3),
        })
        if site == "linkedin":
            linkedin_seen = True
    return {"jobs": list(jobs_by_url.values()), "diagnostics": diagnostics}


class Handler(BaseHTTPRequestHandler):
    server_version = "job-monitor-jobspy/1"

    def log_message(self, fmt, *args):
        print(f"jobspy: {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/jobs":
            self.send_json(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > MAX_BODY_BYTES:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(size))
            self.send_json(200, scrape(payload))
        except Exception as error:  # The caller treats every failed matrix as a retrieval failure.
            self.send_json(502, {"error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
