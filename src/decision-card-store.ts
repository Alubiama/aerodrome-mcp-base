import fs from "node:fs";
import path from "node:path";
import { validateDecisionCard } from "./mcp/decision-card.js";
export function saveDecisionCard(raw: unknown, directory: string) {
  const card=validateDecisionCard(raw);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);
  if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Card directory must be a real directory");
  const filename=path.join(directory,card.cardId+".json");
  const fd=fs.openSync(filename,"wx",0o600);
  try { fs.writeFileSync(fd,JSON.stringify(card,null,2)+"\n"); fs.fsyncSync(fd); }
  finally {fs.closeSync(fd);}
  return filename;
}
