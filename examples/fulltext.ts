import { Velr } from "@velr-ai/velr";

using db = Velr.open("fulltext.velr");

db.run(`
  CREATE (:Paper {
    title: 'Vector Search in Graphs',
    abstract: 'A practical note on vector and graph retrieval'
  }),
  (:Paper {
    title: 'Query Planning',
    abstract: 'How graph databases plan Cypher queries'
  })
`);

db.run(`
  CREATE FULLTEXT INDEX paperText IF NOT EXISTS
  FOR (n:Paper) ON EACH [n.title, n.abstract]
`);

const rows = db.query(`
  CALL db.index.fulltext.queryNodes('paperText', $query)
  YIELD node, score
  RETURN node, score
`, {
  params: { query: 'abstract:vector OR title:"query planning"' }
});

console.log(rows);
