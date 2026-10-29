# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "sentence-transformers>=3.4",
#   "transformers>=4.51",
#   "torch",
#   "numpy",
#   "huggingface_hub",
# ]
# ///
"""
埋め込みモデルの比べ方（docs/spec/14-memory.md「モデルの選び方」の「測り方」）。

このリポジトリ自体（日本語の仕様書と TypeScript のコード）を Akari と同じ規則で切り、
queries.json の問いで、正解のファイルが上位に出るかを測る。速さとメモリも測る。

    uv run tools/embed-bench/bench.py            # 4つのモデルを順に測る（初回はモデルを取得する）
    uv run tools/embed-bench/bench.py --models cl-nagoya/ruri-v3-70m

結果は tools/embed-bench/results/ に Markdown と JSON で出る。Markdown をそのまま貼ってもらえればよい。
CPU で測る（Akari の内蔵の埋め込みは CPU で動かす前提のため）。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import resource
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

DEFAULT_MODELS = [
    "cl-nagoya/ruri-v3-70m",
    "ibm-granite/granite-embedding-97m-multilingual-r2",
    "hotchpotch/bekko-embedding-v1-a25m",
    "codefuse-ai/F2LLM-v2-80M",
]

# モデルの説明に書かれた「文の前に付ける印」。モデル自身が設定に持っていれば、そちらを優先する。
# ここに書いたものは記憶ベースで、確かめていない（結果の表に、実際に使った印を出す）。
PROMPT_HINTS: dict[str, dict[str, str]] = {
    "cl-nagoya/ruri-v3-70m": {"query": "検索クエリ: ", "document": "検索文書: "},
}

QUERY_KEYS = ["query", "search_query", "retrieval.query", "retrieval_query", "Retrieval-query", "retrieval"]
DOC_KEYS = ["document", "passage", "search_document", "retrieval.passage", "retrieval_document", "doc", "Retrieval-document"]

# ---------------- 対象のファイルとチャンク（packages/core/src/memory と同じ規則） ----------------

IGNORE_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__",
    ".next", ".nuxt", ".turbo", ".cache", "coverage", ".gradle", ".idea", ".pytest_cache",
}
SECRET_RE = [
    re.compile(p, re.I)
    for p in [
        r"^\.env(\..*)?$", r"^credentials\.json$", r"^\.npmrc$", r"^\.netrc$",
        r"^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$", r"\.(pem|key|p12|pfx)$",
    ]
]
SKIP_RE = [re.compile(p) for p in [r"\.min\.js$", r"\.min\.css$", r"\.map$", r"\.lock$", r"(^|/)package-lock\.json$", r"(^|/)pnpm-lock\.yaml$"]]
MAX_FILE_BYTES = 1_048_576
CHUNK_CHARS = 1200
OVERLAP_CHARS = 200


def git(*args: str) -> bytes:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True).stdout


def load_corpus(commit: str) -> list[dict]:
    try:
        git("cat-file", "-e", f"{commit}^{{commit}}")
    except subprocess.CalledProcessError:
        sys.exit(f"commit {commit} がありません。git pull してからやり直してください。")
    names = git("ls-tree", "-r", "--name-only", "-z", commit).decode().split("\0")
    files = []
    for rel in sorted(n for n in names if n):
        parts = rel.split("/")
        if any(p in IGNORE_DIRS for p in parts[:-1]) or rel.startswith("tools/embed-bench/"):
            continue
        if any(r.search(parts[-1]) for r in SECRET_RE) or any(r.search(rel) for r in SKIP_RE):
            continue
        data = git("show", f"{commit}:{rel}")
        if len(data) > MAX_FILE_BYTES or b"\0" in data[:8000]:
            continue
        files.append({"path": rel, "text": data.decode("utf-8", errors="replace")})
    chunks = []
    for f in files:
        chunks.extend(chunk_text(f["path"], f["text"], CHUNK_CHARS, OVERLAP_CHARS))
    return chunks


def chunk_text(path: str, content: str, max_chars: int, overlap_chars: int) -> list[dict]:
    """packages/core/src/memory/chunk.ts（lines-v1）と同じ切り方。"""
    max_chars = max(50, max_chars)
    overlap = min(overlap_chars, max_chars // 2)
    lines = content.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if all(l.strip() == "" for l in lines):
        return []
    out = []
    start = 0
    while start < len(lines):
        if len(lines[start]) > max_chars:
            line = lines[start]
            i = 0
            while True:
                out.append({"path": path, "start": start + 1, "end": start + 1, "text": line[i : i + max_chars]})
                if i + max_chars >= len(line):
                    break
                i += max_chars - overlap
            start += 1
            continue
        end = start + 1
        size = len(lines[start]) + 1
        while end < len(lines) and len(lines[end]) <= max_chars and size + len(lines[end]) + 1 <= max_chars:
            size += len(lines[end]) + 1
            end += 1
        text = "\n".join(lines[start:end])
        if text.strip():
            out.append({"path": path, "start": start + 1, "end": end, "text": text})
        if end >= len(lines):
            break
        if len(lines[end]) > max_chars:
            start = end
            continue
        back, kept = end, 0
        while back - 1 > start and kept + len(lines[back - 1]) + 1 <= overlap:
            back -= 1
            kept += len(lines[back]) + 1
        start = back
    return out


def embed_text(c: dict) -> str:
    return f"// {c['path']}:{c['start']}-{c['end']}\n{c['text']}"


# ---------------- 採点 ----------------


def score(sim_rows, chunks: list[dict], queries: list[dict]) -> dict:
    """ファイル単位の順位で採点する（同じファイルの2つ目以降のチャンクは数えない）。"""
    per = []
    for q, sims in zip(queries, sim_rows):
        order = sorted(range(len(sims)), key=lambda i: -sims[i])
        files: list[str] = []
        for i in order:
            p = chunks[i]["path"]
            if p not in files:
                files.append(p)
            if len(files) >= 10:
                break
        rank = next((n + 1 for n, p in enumerate(files) if p in q["gold"]), None)
        per.append({"id": q["id"], "kind": q["kind"], "rank": rank, "top3": files[:3]})
    return {"per_query": per, **summarize(per)}


def summarize(per: list[dict]) -> dict:
    def agg(rows):
        n = len(rows) or 1
        return {
            "hit1": sum(1 for r in rows if r["rank"] == 1) / n,
            "hit5": sum(1 for r in rows if r["rank"] and r["rank"] <= 5) / n,
            "mrr10": sum(1 / r["rank"] for r in rows if r["rank"]) / n,
            "n": len(rows),
        }

    kinds = sorted({r["kind"] for r in per})
    return {"overall": agg(per), "by_kind": {k: agg([r for r in per if r["kind"] == k]) for k in kinds}}


# ---------------- 比べる基準: 文字の2連と単語の TF-IDF（埋め込みを使わない、キーワード検索に近いもの） ----------------


def baseline(chunks: list[dict], queries: list[dict]) -> dict:
    def toks(t: str) -> list[str]:
        t = t.lower()
        words = re.findall(r"[a-z0-9_]{2,}", t)
        cjk = [c for c in t if "぀" <= c <= "ヿ" or "㐀" <= c <= "鿿"]
        return words + [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]

    docs = [toks(embed_text(c)) for c in chunks]
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    n = len(docs)
    idf = {t: math.log((n + 1) / (v + 1)) + 1 for t, v in df.items()}

    def vec(ts):
        v: dict[str, float] = {}
        for t in ts:
            v[t] = v.get(t, 0) + idf.get(t, 0.0)
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        return {t: x / norm for t, x in v.items()}

    dv = [vec(d) for d in docs]
    rows = []
    for q in queries:
        qv = vec(toks(q["q"]))
        rows.append([sum(w * d.get(t, 0) for t, w in qv.items()) for d in dv])
    return score(rows, chunks, queries)


# ---------------- 1つのモデルを測る（別のプロセスで。メモリを分けて測るため） ----------------


def peak_rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


def pick(prompts: dict, keys: list[str]) -> str | None:
    for k in keys:
        if k in prompts:
            return k
    return None


def measure_one(model_id: str, corpus_file: str, args) -> dict:
    data = json.loads(Path(corpus_file).read_text())
    chunks, queries = data["chunks"], data["queries"]
    if model_id.startswith("fake:"):
        return measure_fake(model_id, chunks, queries)

    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    if args.threads:
        torch.set_num_threads(args.threads)
    t0 = time.perf_counter()
    model = SentenceTransformer(model_id, device=args.device, trust_remote_code=args.trust_remote_code)
    load_s = time.perf_counter() - t0
    model.max_seq_length = min(model.max_seq_length or 512, args.max_seq)

    prompts = dict(getattr(model, "prompts", {}) or {})
    qkey, dkey = pick(prompts, QUERY_KEYS), pick(prompts, DOC_KEYS)
    hint = PROMPT_HINTS.get(model_id, {})
    qprompt = prompts[qkey] if qkey else hint.get("query", "")
    dprompt = prompts[dkey] if dkey else hint.get("document", "")

    texts = [embed_text(c) for c in chunks]
    t1 = time.perf_counter()
    # prompt="" を渡して、モデルの既定の印（default_prompt_name）が重ねて付かないようにする（印は上で決めたものだけ）
    doc = model.encode([dprompt + t for t in texts], prompt="", batch_size=args.batch, normalize_embeddings=True,
                       convert_to_numpy=True, show_progress_bar=False)
    index_s = time.perf_counter() - t1

    qtexts = [qprompt + q["q"] for q in queries]
    model.encode(qtexts[:2], prompt="", normalize_embeddings=True)  # 温める
    t2 = time.perf_counter()
    qv = np.stack([model.encode(t, prompt="", normalize_embeddings=True, convert_to_numpy=True) for t in qtexts])
    query_ms = (time.perf_counter() - t2) / len(qtexts) * 1000

    sims = qv @ doc.T
    result = score(sims.tolist(), chunks, queries)
    disk_mb = model_disk_mb(model_id)
    return {
        "model": model_id,
        **result,
        "dims": int(doc.shape[1]),
        "max_seq_length": model.max_seq_length,
        "prompts": {
            "query": qprompt,
            "document": dprompt,
            "available": sorted(prompts.keys()),
            "default": getattr(model, "default_prompt_name", None),
        },
        "load_s": load_s,
        "index_s": index_s,
        "chunks_per_s": len(texts) / index_s if index_s > 0 else None,
        "query_ms": query_ms,
        "peak_rss_mb": peak_rss_mb(),
        "disk_mb": disk_mb,
    }


def measure_fake(model_id: str, chunks, queries) -> dict:
    """モデルを取得せずに、この道具そのものを確かめるための偽物（文字の重なりの数値）。"""
    import hashlib

    dims = 256

    def emb(t: str):
        v = [0.0] * dims
        t = t.lower()
        for w in re.findall(r"[a-z0-9_]{2,}", t):
            v[int(hashlib.md5(w.encode()).hexdigest(), 16) % dims] += 1
        cjk = [c for c in t if "぀" <= c <= "鿿"]
        for i in range(len(cjk) - 1):
            v[int(hashlib.md5((cjk[i] + cjk[i + 1]).encode()).hexdigest(), 16) % dims] += 1
        n = math.sqrt(sum(x * x for x in v)) or 1
        return [x / n for x in v]

    t1 = time.perf_counter()
    doc = [emb(embed_text(c)) for c in chunks]
    index_s = time.perf_counter() - t1
    qv = [emb(q["q"]) for q in queries]
    rows = [[sum(a * b for a, b in zip(q, d)) for d in doc] for q in qv]
    return {
        "model": model_id, **score(rows, chunks, queries), "dims": dims, "max_seq_length": None,
        "prompts": {"query": "", "document": "", "available": []}, "load_s": 0.0, "index_s": index_s,
        "chunks_per_s": len(chunks) / index_s if index_s else None, "query_ms": None,
        "peak_rss_mb": peak_rss_mb(), "disk_mb": None,
    }


def model_disk_mb(model_id: str) -> float | None:
    try:
        from huggingface_hub import scan_cache_dir

        for repo in scan_cache_dir().repos:
            if repo.repo_id == model_id:
                return repo.size_on_disk / (1024 * 1024)
    except Exception:
        pass
    return None


# ---------------- 報告 ----------------


def pct(x) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def num(x, fmt="{:.1f}") -> str:
    return "—" if x is None else fmt.format(x)


def report(results: list[dict], meta: dict) -> str:
    kinds = sorted({k for r in results if "by_kind" in r for k in r["by_kind"]})
    lines = [
        f"# 埋め込みモデルの比較（{meta['date']}）",
        "",
        f"- 機械: {meta['machine']} / Python {meta['python']} / 端末の CPU で測定（{meta['device']}、スレッド {meta['threads']}）",
        f"- 対象: このリポジトリの commit `{meta['commit'][:10]}`、ファイル {meta['files']} 件、チャンク {meta['chunks']} 件",
        f"- 問い: {meta['queries']} 問（正解はファイル単位。上位5件に入れば「5位以内」）",
        "",
        "## 当たり方",
        "",
        "| モデル | 1位 | 5位以内 | MRR@10 | " + " | ".join(f"{k}（5位以内）" for k in kinds) + " |",
        "|---|---|---|---|" + "---|" * len(kinds),
    ]
    for r in results:
        if "error" in r:
            lines.append(f"| {r['model']} | 失敗 | | | " + " | ".join("" for _ in kinds) + " |")
            continue
        o = r["overall"]
        lines.append(
            f"| {r['model']} | {pct(o['hit1'])} | {pct(o['hit5'])} | {o['mrr10']:.3f} | "
            + " | ".join(pct(r["by_kind"].get(k, {}).get("hit5")) for k in kinds)
            + " |"
        )
    lines += [
        "",
        "## 速さと大きさ（CPU）",
        "",
        "| モデル | 次元 | 索引づくり | チャンク/秒 | 問い1つ | 最大メモリ | ディスク | 読み込み |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        if "error" in r or r["model"].startswith("基準"):
            continue
        lines.append(
            f"| {r['model']} | {r['dims']} | {num(r['index_s'])}秒 | {num(r['chunks_per_s'])} | "
            f"{num(r['query_ms'])}ms | {num(r['peak_rss_mb'], '{:.0f}')}MB | {num(r['disk_mb'], '{:.0f}')}MB | {num(r['load_s'])}秒 |"
        )
    lines += ["", "## 使った印（文の前に付けたもの）", ""]
    for r in results:
        if "prompts" in r and not r["model"].startswith("基準"):
            p = r["prompts"]
            lines.append(
                f"- {r['model']}: 問い `{p['query'] or '（なし）'}` / 本文 `{p['document'] or '（なし）'}`"
                f"（モデルが持っていた印: {', '.join(p['available']) or 'なし'}）"
            )
    errors = [r for r in results if "error" in r]
    if errors:
        lines += ["", "## 失敗", ""]
        for r in errors:
            lines.append(f"- {r['model']}: {r['error']}")
    lines += ["", "## 5位以内に入らなかった問い", ""]
    for r in results:
        if "per_query" not in r:
            continue
        miss = [q for q in r["per_query"] if not q["rank"] or q["rank"] > 5]
        lines.append(f"- **{r['model']}**（{len(miss)} 問）: " + (", ".join(f"{q['id']}（{q['rank'] or '圏外'}）" for q in miss) or "なし"))
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description="埋め込みモデルを、このリポジトリで比べる")
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS)
    ap.add_argument("--device", default="cpu", help="既定 cpu（Akari の内蔵は CPU 前提）。参考に mps / cuda も指定できる")
    ap.add_argument("--threads", type=int, default=0, help="CPU のスレッド数。0 で既定")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=2048, help="1回に読む長さの上限（トークン）")
    ap.add_argument("--trust-remote-code", action="store_true",
                    help="モデルの配布元のプログラムを実行して読み込む（読み込めないモデルがあるときだけ。中身は確かめていない）")
    ap.add_argument("--one", help=argparse.SUPPRESS)
    ap.add_argument("--corpus", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.one:
        try:
            print(json.dumps(measure_one(args.one, args.corpus, args), ensure_ascii=False))
        except Exception as e:  # 1つのモデルが失敗しても、ほかは測る
            print(json.dumps({"model": args.one, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return

    qdata = json.loads((HERE / "queries.json").read_text())
    print(f"対象を読み込んでいます（commit {qdata['commit'][:10]}）…", file=sys.stderr)
    chunks = load_corpus(qdata["commit"])
    files = len({c["path"] for c in chunks})
    paths = {c["path"] for c in chunks}
    missing = sorted({g for q in qdata["queries"] for g in q["gold"] if g not in paths})
    if missing:
        sys.exit(f"正解のファイルが対象にありません: {missing}")
    print(f"ファイル {files} 件、チャンク {len(chunks)} 件、問い {len(qdata['queries'])} 問", file=sys.stderr)

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump({"chunks": chunks, "queries": qdata["queries"]}, tf, ensure_ascii=False)
        corpus_file = tf.name

    results = [{"model": "基準: 文字の重なり（埋め込みなし）", **baseline(chunks, qdata["queries"])}]
    try:
        for m in args.models:
            print(f"\n== {m}（初回はモデルを取得します）", file=sys.stderr)
            cmd = [sys.executable, str(Path(__file__).resolve()), "--one", m, "--corpus", corpus_file,
                   "--device", args.device, "--threads", str(args.threads), "--batch", str(args.batch),
                   "--max-seq", str(args.max_seq)] + (["--trust-remote-code"] if args.trust_remote_code else [])
            p = subprocess.run(cmd, capture_output=True, text=True)
            last = [l for l in p.stdout.strip().splitlines() if l.startswith("{")]
            r = json.loads(last[-1]) if last else {"model": m, "error": (p.stderr.strip().splitlines() or ["不明"])[-1]}
            if "error" in r:
                print(f"   失敗: {r['error']}", file=sys.stderr)
            else:
                o = r["overall"]
                print(f"   1位 {pct(o['hit1'])}、5位以内 {pct(o['hit5'])}、索引づくり {r['index_s']:.1f}秒", file=sys.stderr)
            results.append(r)
    finally:
        os.unlink(corpus_file)

    meta = {
        "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "machine": f"{platform.system()} {platform.machine()} {platform.processor() or ''}".strip(),
        "python": platform.python_version(),
        "device": args.device,
        "threads": args.threads or "既定",
        "commit": qdata["commit"],
        "files": files,
        "chunks": len(chunks),
        "queries": len(qdata["queries"]),
    }
    md = report(results, meta)
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (out / f"{stamp}.md").write_text(md)
    (out / f"{stamp}.json").write_text(json.dumps({"meta": meta, "results": results}, ensure_ascii=False, indent=2))
    print("\n" + md)
    print(f"保存しました: {out / (stamp + '.md')}", file=sys.stderr)


if __name__ == "__main__":
    main()
