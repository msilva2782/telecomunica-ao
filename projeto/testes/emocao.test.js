// Testes do detector de emoção da página /conversa/.  Rodar:  node testes/emocao.test.js
"use strict";
const assert = require("assert");
const { analisar } = require("../conversa/emocao.js");

const casos = [
  ["hoje eu tô muito triste", "triste"],
  ["meu cachorro morreu ontem", "triste"],
  ["estou com saudade da minha mãe", "triste"],
  ["não estou bem", "triste"],
  ["eu não tô feliz com isso", "triste"],
  ["fui reprovado na matéria", "triste"],
  ["que legal!", "feliz"],
  ["passei na prova!", "feliz"],
  ["eu adoro programar", "feliz"],
  ["kkkk que engraçado", "feliz"],
  ["bom dia, robô", "feliz"],
  ["estou muito feliz hoje", "feliz"],
  ["nossa, não acredito", "surpreso"],
  ["sério? uau", "surpreso"],
  ["tô com medo da prova amanhã", "preocupado"],
  ["estou muito ansioso", "preocupado"],
  ["eu odeio quando isso acontece", "preocupado"],
  ["o que você sabe fazer", "pensativo"],
  ["qual é o seu nome", "pensativo"],
  ["como funciona isso?", "pensativo"],
  ["eu moro em São Paulo", "neutro"],
  ["hoje choveu", "neutro"],
  ["não estou triste", "feliz"],
  ["sem problema", "feliz"],
];

let falhas = 0;
for (const [frase, esperado] of casos) {
  const r = analisar(frase);
  const ok = r.emocao === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? "ok  " : "FALHOU"} ${JSON.stringify(frase)} -> ${r.emocao} ${r.intensidade} ${r.palavras.join(",")}` +
              (ok ? "" : `  (esperado ${esperado})`));
}
const forte = analisar("estou muito muito triste").intensidade;
const fraco = analisar("estou triste").intensidade;
assert.ok(forte > fraco, "intensificador deve aumentar a intensidade");
assert.strictEqual(analisar("").emocao, "neutro");
console.log(`\n${casos.length - falhas} de ${casos.length} frases corretas`);
process.exit(falhas ? 1 : 0);
