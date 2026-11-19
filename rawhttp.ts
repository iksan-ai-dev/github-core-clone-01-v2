// Minimal HTTP/1.1 server on a raw TCP socket.
//
// Drop-in for `createServer` from node:http for this entry's needs. node:http costs
// ~320us per request under gVisor: it re-parses into IncomingMessage/ServerResponse
// objects and writes the status line, headers and body as separate syscalls. Here the
// whole response is concatenated once and leaves in a single sock.write().
//
// Supported: keep-alive, pipelining, Content-Length and chunked request bodies, HEAD,
// Connection: close. Exposes the surface the entry uses: req.method, req.url,
// req.headers, req.on('data'|'end'|'error'), res.writeHead, res.setHeader, res.end,
// server.listen, server.address, server.close.
import { createServer as createNetServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
};

export class RawReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  httpVersion = '1.1';
  socket: Socket;
  private readonly body: Buffer;
  private emitted = false;

  constructor(method: string, url: string, headers: Record<string, string>, body: Buffer, socket: Socket) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
    this.socket = socket;
  }

  /** Replay the already-parsed body to whatever listeners the handler attaches. */
  flush(): void {
    if (this.emitted) return;
    this.emitted = true;
    process.nextTick(() => {
      if (this.body.length > 0) this.emit('data', this.body);
      this.emit('end');
    });
  }
}

export class RawRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  private finished = false;
  private readonly sock: Socket;
  private readonly head: boolean;

  constructor(sock: Socket, head: boolean) {
    this.sock = sock;
    this.head = head;
  }

  writeHead(status: number, headers?: Record<string, string | number | undefined>): this {
    this.statusCode = status;
    if (headers) this.setHeaders(headers);
    return this;
  }

  setHeader(name: string, value: string | number): this {
    this.headers[name] = String(value);
    return this;
  }

  setHeaders(headers: Record<string, string | number | undefined>): this {
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (value !== undefined) this.headers[key] = String(value);
    }
    return this;
  }

  end(data?: string | Buffer): void {
    if (this.finished) return;
    this.finished = true;
    const body = data === undefined ? null : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const length = body === null ? 0 : body.length;
    const lines = [`HTTP/1.1 ${this.statusCode} ${STATUS_TEXT[this.statusCode] ?? 'OK'}\r\n`];
    lines.push(`Content-Length: ${length}\r\n`);
    for (const key of Object.keys(this.headers)) {
      // Content-Length is emitted once, below, from the actual body length. A
      // caller-supplied copy would be a duplicate header and undici rejects it
      // with ResponseContentLengthMismatchError.
      if (key.toLowerCase() === 'content-length') continue;
      lines.push(`${key}: ${this.headers[key]}\r\n`);
    }
    lines.push('\r\n');
    const headBuf = Buffer.from(lines.join(''), 'latin1');
    // One syscall: status line, headers and body concatenated up front.
    if (this.head || body === null || length === 0) this.sock.write(headBuf);
    else this.sock.write(Buffer.concat([headBuf, body]));
    if (this.headers['Connection'] === 'close') this.sock.end();
  }
}

export interface RawServer {
  listen(port: number, cb?: () => void): void;
  address(): { port: number } | null;
  close(): void;
  readonly sockets: Set<Socket>;
}

type Handler = (req: RawReq, res: RawRes) => void;

export function createServer(handler: Handler): RawServer {
  const sockets = new Set<Socket>();
  let boundPort = 0;

  const net = createNetServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.setNoDelay(true);
    let acc: Buffer = Buffer.alloc(0);

    const pump = (): void => {
      for (;;) {
        const headEnd = acc.indexOf('\r\n\r\n');
        if (headEnd < 0) return;

        const lines = acc.toString('latin1', 0, headEnd).split('\r\n');
        const requestLine = lines[0] ?? '';
        const sp1 = requestLine.indexOf(' ');
        const sp2 = requestLine.lastIndexOf(' ');
        if (sp1 < 0 || sp2 <= sp1) { acc = Buffer.alloc(0); sock.destroy(); return; }
        const method = requestLine.slice(0, sp1);
        const url = requestLine.slice(sp1 + 1, sp2);
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i] as string;
          const colon = line.indexOf(':');
          if (colon <= 0) continue;
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }

        const bodyStart = headEnd + 4;
        const wantsClose = (headers['connection'] ?? '').toLowerCase() === 'close';
        const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');

        if (chunked) {
          const parsed = decodeChunked(acc, bodyStart);
          if (parsed === null) return; // need more bytes
          acc = acc.subarray(parsed.next);
          const res = new RawRes(sock, method === 'HEAD');
          if (wantsClose) res.headers['Connection'] = 'close';
          const reqA = new RawReq(method, url, headers, parsed.body, sock);
          handler(reqA, res);
          reqA.flush();
          if (wantsClose) return;
          continue;
        }

        const bodyLen = headers['content-length'] !== undefined ? parseInt(headers['content-length'], 10) || 0 : 0;
        if (acc.length < bodyStart + bodyLen) return; // need more bytes
        const body = bodyLen > 0 ? acc.subarray(bodyStart, bodyStart + bodyLen) : Buffer.alloc(0);
        acc = acc.subarray(bodyStart + bodyLen);
        const res = new RawRes(sock, method === 'HEAD');
        if (wantsClose) res.headers['Connection'] = 'close';
        const reqB = new RawReq(method, url, headers, body, sock);
        handler(reqB, res);
        reqB.flush();
        if (wantsClose) return;
      }
    };

    sock.on('data', (chunk: Buffer) => {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      pump();
    });
    sock.on('end', () => sock.end());
  });

  return {
    listen(p: number, cb?: () => void): void {
      boundPort = p;
      net.listen(p, '0.0.0.0', () => cb?.());
    },
    address(): { port: number } | null {
      const addr = net.address();
      if (addr && typeof addr === 'object') return { port: addr.port };
      return boundPort ? { port: boundPort } : null;
    },
    close(): void {
      for (const s of sockets) s.destroy();
      net.close();
    },
    sockets,
  };
}

function decodeChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let off = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', off);
    if (lineEnd < 0) return null;
    const size = parseInt(buf.toString('latin1', off, lineEnd).split(';')[0] as string, 16);
    if (!Number.isFinite(size)) return null;
    off = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = buf.indexOf('\r\n', off);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(parts), next: trailerEnd + 2 };
    }
    if (buf.length < off + size + 2) return null;
    parts.push(buf.subarray(off, off + size));
    off += size + 2;
  }
}
