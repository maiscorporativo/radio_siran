import path from 'node:path';

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
