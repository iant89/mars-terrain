export type ChunkStatus='pending'|'generating'|'complete'|'error';
// `heights` / `materials` are the live Float32/Uint8 grids the worker hands
// back with the .mars blob — the renderer draws them directly (the blob keeps
// its own copy of the same bytes for export).
export type Chunk={id:string;face:number;x:number;y:number;status:ChunkStatus;size:number;progress:number;error?:string;blob?:Blob;crc?:number;heights?:Float32Array;materials?:Uint8Array;cached?:boolean};
