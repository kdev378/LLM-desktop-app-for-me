# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "sentence-transformers>=3.4",
#   "transformers>=4.51",
#   "torch",
#   "onnx",
#   "onnxruntime",
#   "numpy",
#   "sentencepiece",
#   "protobuf",
#   "tokenizers",
# ]
# ///
"""
埋め込みモデルを ONNX（Node から動かせる形）に書き出し、Node 側の確かめ（node/check.mjs）の材料を作る。
docs/spec/14-memory.md「モデルの選び方」の次の段: Akari の動く環境（Node）で動くか、速さとメモリは。

    uv run tools/embed-bench/export_onnx.py                # 既定: cl-nagoya/ruri-v3-70m（印あり）
    cd tools/embed-bench/node && npm install && node check.mjs

書き出すもの（tools/embed-bench/work/<名前>/）:
    model.onnx           … 元の精度（fp32）
    model_int8.onnx      … 軽くした版（8ビット）
    tokenizer.json ほか  … 文を数字の列に変えるための表
    meta.json            … まとめ方（プーリング）・文の前の印・読める長さ
    corpus.json          … 比べるための対象（bench.py と同じ）と問い
    reference.json       … 元のモデル（Python）で作った答えのベクトルと、文を数字に変えた結果（Node と突き合わせる）
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bench  # noqa: E402  対象の切り方・問いは bench.py と同じものを使う

DEFAULT_MODEL = "cl-nagoya/ruri-v3-70m"
PREFIXES = {"cl-nagoya/ruri-v3-70m": {"query": "検索クエリ: ", "document": "検索文書: "}}
REF_CHUNKS = 100  # 元のモデルと突き合わせるチャンクの数


def main() -> None:
    ap = argparse.ArgumentParser(description="埋め込みモデルを ONNX に書き出す")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-seq", type=int, default=2048)
    ap.add_argument("--fake", action="store_true", help=argparse.SUPPRESS)  # 取得なしで道具を確かめる偽のモデル
    args = ap.parse_args()

    qdata = json.loads((HERE / "queries.json").read_text())
    chunks = bench.load_corpus(qdata["commit"])
    name = "fake" if args.fake else args.model.split("/")[-1]
    out = HERE / "work" / name
    out.mkdir(parents=True, exist_ok=True)
    prefixes = {"query": "", "document": ""} if args.fake else PREFIXES.get(args.model, {"query": "", "document": ""})

    docs = [prefixes["document"] + bench.embed_text(c) for c in chunks]
    queries = [prefixes["query"] + q["q"] for q in qdata["queries"]]
    sample = queries + docs[:REF_CHUNKS]

    if args.fake:
        meta, ref_vecs, ref_ids = export_fake(out, docs + queries, sample)
    else:
        meta, ref_vecs, ref_ids = export_real(args.model, out, args.max_seq, sample)
    meta.update({"model": "fake" if args.fake else args.model, "prefixes": prefixes})

    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    (out / "corpus.json").write_text(
        json.dumps({"commit": qdata["commit"], "chunks": chunks, "queries": qdata["queries"]}, ensure_ascii=False)
    )
    (out / "reference.json").write_text(
        json.dumps(
            {
                "note": "最初の len(queries) 件が問い、残りがチャンクの先頭から。どちらも印を付けた文",
                "queries": len(queries),
                "texts": sample,
                "vectors": ref_vecs,
                "token_ids": ref_ids,
            },
            ensure_ascii=False,
        )
    )
    for f in sorted(out.iterdir()):
        print(f"  {f.name:24s} {f.stat().st_size / 1_048_576:8.1f} MB", file=sys.stderr)
    print(f"\n書き出しました: {out}\n次は: cd {HERE / 'node'} && npm install && node check.mjs", file=sys.stderr)


def export_real(model_id: str, out: Path, max_seq: int, sample: list[str]):
    import numpy as np
    import onnxruntime as ort
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from sentence_transformers import SentenceTransformer
    from transformers import AutoConfig, AutoModel, AutoTokenizer

    print(f"{model_id} を読み込んでいます…", file=sys.stderr)
    # transformers v5 は設定の dtype のまま読み込む。bfloat16 の重みは CPU で遅く、ONNX の書き出しと8ビット化も崩れうるので float32 に揃える
    st = SentenceTransformer(model_id, device="cpu", model_kwargs={"dtype": torch.float32})
    modules = [type(m).__name__ for m in st]
    extra = [m for m in modules if m not in ("Transformer", "Pooling", "Normalize")]
    if extra:
        sys.exit(f"Node 側で再現していない部品があります: {extra}（このモデルはこの道具では確かめられない）")
    pooling = st[1].get_pooling_mode_str()
    if pooling not in ("mean", "cls", "lasttoken"):
        sys.exit(f"まとめ方 {pooling} は Node 側で再現していません")
    max_len = min(st.max_seq_length or 512, max_seq)

    tok = AutoTokenizer.from_pretrained(model_id, use_fast=True)
    if not tok.is_fast:
        sys.exit("このモデルの文の区切り方を tokenizer.json に書き出せません（Node 側で使えない）")
    tok.save_pretrained(out)

    config = AutoConfig.from_pretrained(model_id)
    if hasattr(config, "reference_compile"):
        config.reference_compile = False  # ModernBERT の torch.compile を使わない（書き出せないため）
    try:
        model = AutoModel.from_pretrained(model_id, config=config, attn_implementation="eager", dtype=torch.float32)
    except TypeError:  # dtype の引数が無い古い transformers
        model = AutoModel.from_pretrained(model_id, config=config, attn_implementation="eager", torch_dtype=torch.float32)
    model = model.float().eval()

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask):
            return self.m(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    enc = tok(["検索文書: 書き出しの見本です。", "short"], padding=True, return_tensors="pt")
    fp32 = out / "model.onnx"
    print("ONNX に書き出しています…", file=sys.stderr)
    kwargs = dict(
        input_names=["input_ids", "attention_mask"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "last_hidden_state": {0: "batch", 1: "seq"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    with torch.no_grad():
        try:
            torch.onnx.export(Wrap(model), (enc["input_ids"], enc["attention_mask"]), str(fp32), dynamo=False, **kwargs)
        except TypeError:  # 古い torch には dynamo の引数が無い
            torch.onnx.export(Wrap(model), (enc["input_ids"], enc["attention_mask"]), str(fp32), **kwargs)

    print("8ビット版を作っています…", file=sys.stderr)
    int8 = out / "model_int8.onnx"
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)

    # 元のモデル（sentence-transformers）の答え。印は文に付けてあるので、モデルの既定の印は重ねない
    ref = st.encode(sample, prompt="", normalize_embeddings=True, convert_to_numpy=True, batch_size=16)

    # Python の ONNX 実行で、書き出しが壊れていないかを先に見る
    for path in (fp32, int8):
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        got = []
        for i in range(0, len(sample), 16):
            b = tok(sample[i : i + 16], padding=True, truncation=True, max_length=max_len, return_tensors="np")
            h = sess.run(None, {"input_ids": b["input_ids"].astype(np.int64), "attention_mask": b["attention_mask"].astype(np.int64)})[0]
            got.extend(pool(h, b["attention_mask"], pooling))
        cos = [float(np.dot(a, b)) for a, b in zip(ref, got)]
        print(f"  {path.name}: 元のモデルとの近さ 最小 {min(cos):.5f} / 平均 {sum(cos) / len(cos):.5f}", file=sys.stderr)
        if min(cos) < 0.99:
            print("  ! 書き出しがずれています（Node でも同じずれが出るはず）", file=sys.stderr)

    ids = [tok(t, truncation=True, max_length=max_len)["input_ids"] for t in sample]
    meta = {
        "pooling": pooling,
        "max_length": max_len,
        "hidden": int(ref.shape[1]),
        "modules": modules,
        "pad_token_id": tok.pad_token_id,
        "torch": torch.__version__,
        "onnxruntime_python": ort.__version__,
    }
    return meta, [list(map(float, v)) for v in ref], ids


def pool(h, mask, mode):
    import numpy as np

    if mode == "cls":
        v = h[:, 0]
    elif mode == "lasttoken":
        idx = mask.sum(1) - 1
        v = h[np.arange(len(h)), idx]
    else:
        m = mask[..., None].astype(np.float32)
        v = (h * m).sum(1) / np.maximum(m.sum(1), 1e-9)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def export_fake(out: Path, all_texts: list[str], sample: list[str]):
    """取得なしで Node 側を確かめるための偽物。文字1つを1語とし、語ごとの固定のベクトルを平均する。"""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper
    from tokenizers import Regex, Tokenizer, models, pre_tokenizers, processors

    chars = sorted({c for t in all_texts for c in t})
    vocab = {"[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, **{c: i + 4 for i, c in enumerate(chars)}}
    tk = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    tk.pre_tokenizer = pre_tokenizers.Split(Regex(r"[\s\S]"), "isolated")
    tk.post_processor = processors.TemplateProcessing(
        single="[CLS] $A [SEP]", special_tokens=[("[CLS]", 2), ("[SEP]", 3)]
    )
    tk.save(str(out / "tokenizer.json"))
    (out / "tokenizer_config.json").write_text(json.dumps({"tokenizer_class": "PreTrainedTokenizerFast", "pad_token": "[PAD]"}))

    hidden = 64
    rng = np.random.default_rng(0)
    table = rng.standard_normal((len(vocab), hidden)).astype(np.float32)
    graph = helper.make_graph(
        [helper.make_node("Gather", ["table", "input_ids"], ["last_hidden_state"])],
        "fake",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"]),
        ],
        [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["batch", "seq", hidden])],
        [helper.make_tensor("table", TensorProto.FLOAT, table.shape, table.flatten().tolist())],
    )
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 8
    onnx.save(m, str(out / "model.onnx"))
    onnx.save(m, str(out / "model_int8.onnx"))  # 偽物では同じもの

    ids = [tk.encode(t).ids for t in sample]
    vecs = []
    for seq in ids:
        v = table[seq].mean(0)
        vecs.append([float(x) for x in v / math.sqrt(float((v * v).sum()))])
    meta = {"pooling": "mean", "max_length": 2048, "hidden": hidden, "modules": ["fake"], "pad_token_id": 0}
    return meta, vecs, ids


if __name__ == "__main__":
    main()
