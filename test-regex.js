const text = `### v0.1 (shipped 2026-03-10)
- [x] Core engine — garage.py (889 lines), pure algorithmic, no LLM dependency
- [x] AI vehicle generator — GPT-5.4 picks trade parameters from thesis
- [x] Basic web dashboard`;

// Try different regexes
const regex1 = /### v([\d.]+)(?:\s*\(([^)]*)\))?[:\s—]*\s*(.+?)(?=### v|$)/g;
const regex2 = /### v([\d.]+)(?:\s*\(([^)]*)\))?[:\s—]*(.*?)(?=### v|$)/gs;
const regex3 = /^### v([\d.]+)(?:\s*\(([^)]*)\))?[:\s—]*(.*)/gm;

console.log('Testing regex1:');
let m = regex1.exec(text);
if (m) {
  console.log('Match:', { version: m[1], metadata: m[2], title: m[3] });
}

console.log('\nTesting regex2:');
regex2.lastIndex = 0;
m = regex2.exec(text);
if (m) {
  console.log('Match:', { version: m[1], metadata: m[2], title: m[3].substring(0, 50) });
}

console.log('\nTesting regex3:');
regex3.lastIndex = 0;
m = regex3.exec(text);
if (m) {
  console.log('Match:', { version: m[1], metadata: m[2], title: m[3].substring(0, 50) });
}

// Look for pattern
const hasVersions = /### v[\d.]+/.test(text);
console.log('\nHas ### v pattern:', hasVersions);
