import { Velr } from "@velr-ai/velr";

using db = Velr.open("basic.velr");

db.run(`
  CREATE (:Person {name: 'Ada', age: 37}),
         (:Person {name: 'Grace', age: 41})
`);

const rows = db.query<{ name: string; age: number }>(
  `
  MATCH (p:Person)
  WHERE p.age >= $minAge
  RETURN p.name AS name, p.age AS age
  ORDER BY age
  `,
  {
    params: { minAge: 38 },
    int64: "number"
  }
);

console.log(rows);
