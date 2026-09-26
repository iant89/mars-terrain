export type ChunkStatus='pending'|'generating'|'complete'|'error';
export type Chunk={id:string;face:number;x:number;y:number;status:ChunkStatus;size:number;progress:number;error?:string;blob?:Blob;heights?:Float32Array};
