"""
Flower Brain Cell — Relevance Scorer
Standalone inference server. Call from Node.js via stdin/stdout JSON.

Usage:
  echo '{"query":"who is gavin","blocks":[{"id":1,"content":"Gavin is...","keywords":"gavin"}]}' | python3 cell-scorer.py

Input:  {"query": "...", "blocks": [{"id": N, "content": "...", "keywords": "..."}]}
Output: {"scores": [{"id": N, "score": 0.95, "class": "relevant"}, ...]}
"""
import sys
import json
import re
import torch
import torch.nn as nn
import torch.nn.functional as F
import os

MODEL_PATH = os.environ.get("CELL_MODEL", os.path.join(os.path.dirname(__file__), "cell-scorer.pt"))

STOPWORDS = set("the a an is are was were be been have has had do does did will would could should may might can to of in for on with at by from as into through and but or not so what which who how when where why i me my we you your he him she her it its they them their this that these those".split())
MAX_TOKENS = 64
CLASS_NAMES = {0: "irrelevant", 1: "void", 2: "relevant"}

def tokenize(text):
    return [w for w in re.sub(r'[^a-z0-9\s]', ' ', text.lower()).split() if len(w) > 2 and w not in STOPWORDS]

class BitLinear(nn.Module):
    def __init__(self, in_f, out_f):
        super().__init__()
        self.weight = nn.Parameter(torch.zeros(out_f, in_f))
        self.bias = nn.Parameter(torch.zeros(out_f))
        self.rms_norm = nn.RMSNorm(in_f)
    def forward(self, x):
        x = self.rms_norm(x)
        gamma = self.weight.abs().mean() + 1e-5
        w_s = self.weight / gamma
        w_q = (w_s.round().clamp(-1, 1) - w_s).detach() + w_s
        return F.linear(x, w_q * gamma, self.bias)

class RelevanceCell(nn.Module):
    def __init__(self, vocab_size, embed_dim, hidden_dim):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, embed_dim, padding_idx=0)
        self.query_proj = BitLinear(embed_dim, hidden_dim)
        self.block_proj = BitLinear(embed_dim, hidden_dim)
        self.classifier = nn.Sequential(
            BitLinear(hidden_dim * 2, hidden_dim), nn.GELU(),
            BitLinear(hidden_dim, hidden_dim // 2), nn.GELU(),
            BitLinear(hidden_dim // 2, 3),
        )
    def forward(self, q, b):
        qe = self.query_proj(self.embed(q).mean(dim=1))
        be = self.block_proj(self.embed(b).mean(dim=1))
        return self.classifier(torch.cat([qe, be], dim=-1))

# Load model
ckpt = torch.load(MODEL_PATH, map_location='cpu', weights_only=False)
vocab = ckpt['vocab']
cfg = ckpt['config']
model = RelevanceCell(cfg['vocab_size'], cfg['embed_dim'], cfg['hidden'])
model.load_state_dict(ckpt['model'])
model.eval()

def encode(text):
    tokens = tokenize(text)
    ids = [vocab.get(t, 1) for t in tokens[:MAX_TOKENS]]
    ids += [0] * (MAX_TOKENS - len(ids))
    return ids

def score_blocks(query, blocks):
    """Score a batch of blocks against a query. Returns sorted scores."""
    if not blocks:
        return []

    q_enc = encode(query)
    q_batch = torch.tensor([q_enc] * len(blocks), dtype=torch.long)
    b_batch = torch.tensor(
        [encode(b.get('content', '')[:150] + ' ' + b.get('keywords', '')) for b in blocks],
        dtype=torch.long
    )

    with torch.no_grad():
        logits = model(q_batch, b_batch)
        probs = F.softmax(logits, dim=-1)
        # Score: P(relevant) - P(irrelevant), range [-1, 1]
        scores = (probs[:, 2] - probs[:, 0]).tolist()
        classes = logits.argmax(dim=-1).tolist()

    results = []
    for i, block in enumerate(blocks):
        results.append({
            'id': block.get('id', i),
            'score': round(scores[i], 4),
            'class': CLASS_NAMES[classes[i]],
            'p_relevant': round(probs[i][2].item(), 4),
            'p_void': round(probs[i][1].item(), 4),
            'p_irrelevant': round(probs[i][0].item(), 4),
        })

    results.sort(key=lambda x: -x['score'])
    return results

# ── Server mode: read JSON lines from stdin ──
if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--server':
        # Continuous server mode for Node.js child_process
        sys.stderr.write(f"Cell scorer ready. Model: {MODEL_PATH} ({sum(p.numel() for p in model.parameters()):,} params)\n")
        sys.stderr.flush()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                query = req.get('query', '')
                blocks = req.get('blocks', [])
                results = score_blocks(query, blocks)
                print(json.dumps({'scores': results}), flush=True)
            except Exception as e:
                print(json.dumps({'error': str(e)}), flush=True)
    else:
        # Single-shot mode
        inp = sys.stdin.read().strip()
        if inp:
            req = json.loads(inp)
            results = score_blocks(req.get('query', ''), req.get('blocks', []))
            print(json.dumps({'scores': results}, indent=2))
        else:
            print("Usage: echo '{\"query\":\"...\",\"blocks\":[...]}' | python3 cell-scorer.py")
            print("   or: python3 cell-scorer.py --server  (continuous stdin/stdout)")
