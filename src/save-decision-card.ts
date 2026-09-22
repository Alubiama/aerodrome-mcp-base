import path from "node:path";
import { saveDecisionCard } from "./decision-card-store.js";
try {
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of process.stdin) {
    const b=Buffer.from(chunk); size+=b.length;
    if(size>2_000_000) throw new Error("Card exceeds input limit");
    chunks.push(b);
  }
  const raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  console.log(saveDecisionCard(raw,path.resolve(".decision-cards")));
} catch {console.error("Card not saved: invalid input, existing card, or unavailable private directory.");process.exitCode=1;}
