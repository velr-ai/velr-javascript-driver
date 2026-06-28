import { Velr, type VectorEmbedder } from "velr";

function toyVector(text: string, dimensions: number): Float32Array {
  const out = new Float32Array(dimensions);
  for (let i = 0; i < text.length; i += 1) {
    out[i % dimensions] += text.charCodeAt(i) / 255;
  }

  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

const embedder: VectorEmbedder = (inputs) =>
  inputs.map((input) => {
    const text = input.fields
      .map((field) => String(field.value ?? field.display ?? ""))
      .join("\n");
    return toyVector(text, input.dimensions);
  });

using db = Velr.open("vector.velr");
db.registerVectorEmbedder("toy", embedder);

db.run(`
  CREATE (:Paper {title: 'Alpha Paper', abstract: 'alpha graph'}),
         (:Paper {title: 'Beta Paper', abstract: 'beta graph'})
`);

db.run(`
  CREATE VECTOR INDEX paperEmbedding IF NOT EXISTS
  FOR (n:Paper)
  ON EACH [n.title, n.abstract]
  OPTIONS {
    indexConfig: {
      dimensions: 3,
      metric: 'cosine',
      embedder: 'toy'
    }
  }
`);

const rows = db.query(`
  CALL db.index.vector.queryNodes('paperEmbedding', 2, $query)
  YIELD node, score
  RETURN node, score
`, {
  params: { query: "alpha graph" }
});

console.log(rows);
