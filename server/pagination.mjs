export function encodeCursor(item,dateField='createdAt'){
  return Buffer.from(JSON.stringify([item[dateField],item.id])).toString('base64url');
}
export function decodeCursor(value){
  if(!value)return null;
  try{
    if(!/^[A-Za-z0-9_-]{1,768}$/.test(value))throw new Error();
    const cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||!Number.isFinite(Date.parse(cursor[0]))||typeof cursor[1]!=='string'||!cursor[1]||cursor[1].length>100||cursor[1].includes('\u0000'))throw new Error();
    return [new Date(cursor[0]).toISOString(),cursor[1]];
  }catch{throw Object.assign(new Error('Invalid page cursor'),{status:400});}
}
export function page(items,cursor,dateField='createdAt',limit=50){
  const sorted=[...items].sort((a,b)=>String(b[dateField]).localeCompare(String(a[dateField]))||b.id.localeCompare(a.id));
  const candidates=cursor?sorted.filter(item=>String(item[dateField])<cursor[0]||String(item[dateField])===cursor[0]&&item.id<cursor[1]):sorted;
  const selected=candidates.slice(0,limit);
  return {items:selected,nextCursor:candidates.length>limit&&selected.length?encodeCursor(selected.at(-1),dateField):null};
}
