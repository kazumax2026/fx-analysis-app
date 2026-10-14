export const MOCK_NOW=Date.UTC(2026,6,6,12,0,30);
export function ohlcFixture(kind='normal',symbol='USD/JPY'){
 const end=Math.floor(MOCK_NOW/300000)*300000;
 const b={meta:{symbol,interval:'5min',exchange_timezone:'UTC'},values:Array.from({length:302},(_,i)=>({datetime:new Date(end-i*300000).toISOString().slice(0,19).replace('T',' '),open:'150.1',high:'150.3',low:'149.9',close:'150.2'}))};
 if(kind==='missing')b.values.splice(20,1); // legitimate gap, never invent bars
 if(kind==='duplicate')b.values[20]=structuredClone(b.values[19]);
 if(kind==='invalid-price')b.values[20].close='bad';
 if(kind==='old')b.values=b.values.slice(4);
 if(kind==='insufficient')b.values=b.values.slice(0,10);
 return b; // includes a forming bar at index zero
}
