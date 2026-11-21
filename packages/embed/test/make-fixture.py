"""
テスト用の小さな偽の埋め込みモデル（test/fixtures/tiny/）を作る。Ruri を取得せずに、
本物の onnxruntime と係のプロセスを通しで確かめるため。中身は「文字ごとの決まったベクトルの平均」。

    uv run --no-project --with onnx --with numpy --with tokenizers python packages/embed/test/make-fixture.py
"""
import json
import math
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper
from tokenizers import Regex, Tokenizer, models, pre_tokenizers, processors

OUT = Path(__file__).resolve().parent / "fixtures" / "tiny"
OUT.mkdir(parents=True, exist_ok=True)

chars = [chr(c) for c in range(0x20, 0x7F)] + list("\n") + [chr(c) for c in range(0x3041, 0x3097)] + [chr(c) for c in range(0x30A1, 0x30FB)]
chars += list("認証処理合計計算検索文書日本語設計鍵会話圧縮索引作業変更記録取消道具承認実行外部接続先秘密読書")
vocab = {"[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3}
for c in chars:
    vocab.setdefault(c, len(vocab))
# WordLevel は @huggingface/tokenizers（JS）が語彙にない字を扱えないため、1字ずつの WordPiece にする
tk = Tokenizer(models.WordPiece(vocab, unk_token="[UNK]"))
tk.pre_tokenizer = pre_tokenizers.Split(Regex(r"[\s\S]"), "isolated")
tk.post_processor = processors.TemplateProcessing(single="[CLS] $A [SEP]", special_tokens=[("[CLS]", 2), ("[SEP]", 3)])
tk.save(str(OUT / "tokenizer.json"))
(OUT / "tokenizer_config.json").write_text(json.dumps({"tokenizer_class": "PreTrainedTokenizerFast", "pad_token": "[PAD]"}))

hidden = 16
table = np.random.default_rng(7).standard_normal((len(vocab), hidden)).astype(np.float32)
graph = helper.make_graph(
    [helper.make_node("Gather", ["table", "input_ids"], ["last_hidden_state"])],
    "tiny",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"]),
    ],
    [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["batch", "seq", hidden])],
    [helper.make_tensor("table", TensorProto.FLOAT, table.shape, table.flatten().tolist())],
)
m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
m.ir_version = 8
onnx.save(m, str(OUT / "model.onnx"))

prefixes = {"query": "q: ", "document": "d: "}
texts = [prefixes["query"] + t for t in ["認証の処理はどこ", "合計を計算する", "hello world"]] + [
    prefixes["document"] + t for t in ["// auth.ts\nexport function login() {}", "日本語の設計の文書（語彙にない字: 鱻）", "export const total = 1;"]
]
vecs = []
for t in texts:
    ids = tk.encode(t).ids
    v = table[ids].mean(0)
    vecs.append([float(x) for x in v / math.sqrt(float((v * v).sum()))])
(OUT / "meta.json").write_text(json.dumps({"model": "akari-test/tiny", "pooling": "mean", "max_length": 512, "hidden": hidden, "pad_token_id": 0, "prefixes": prefixes, "modules": ["fake"]}, ensure_ascii=False, indent=2))
(OUT / "reference.json").write_text(json.dumps({"queries": 3, "texts": texts, "vectors": vecs, "token_ids": [tk.encode(t).ids for t in texts]}, ensure_ascii=False))
print("作りました:", OUT, sorted(p.name for p in OUT.iterdir()))
