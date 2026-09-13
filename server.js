import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Config (set these as environment variables wherever you deploy this)
// ---------------------------------------------------------------------------
// GOOGLE_SERVICE_ACCOUNT_JSON : the FULL content of your service account JSON
//                               key file, base64-encoded (see README).
// SPREADSHEET_ID              : the ID from your Google Sheet's URL
//                               (…/spreadsheets/d/<THIS_PART>/edit).
// PORT                        : optional, defaults to 3000.
// AUTH_TOKEN                  : optional shared secret. If set, every request
//                               must include header
//                               "Authorization: Bearer <AUTH_TOKEN>".
// ---------------------------------------------------------------------------

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN; // optional simple shared-secret auth

if (!SPREADSHEET_ID) {
  console.error('Missing SPREADSHEET_ID env var.');
  process.exit(1);
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var.');
  process.exit(1);
}

const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf-8')
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// ---------------------------------------------------------------------------
// MCP server: 3 tools — read_rows, append_row, update_range
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer(
    { name: 'google-sheets-db', version: '1.0.0' },
    { capabilities: {} }
  );

  server.registerTool(
    'read_rows',
    {
      description:
        "Đọc dữ liệu từ Google Sheet. Trả về mảng các dòng (mỗi dòng là mảng ô).",
      inputSchema: {
        range: z
          .string()
          .default('Sheet1!A1:Z1000')
          .describe("Vùng A1 cần đọc, ví dụ 'Sheet1!A1:D50'. Mặc định đọc cả sheet đầu tiên.")
      }
    },
    async ({ range }) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range
      });
      const rows = res.data.values || [];
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }]
      };
    }
  );

  server.registerTool(
    'append_row',
    {
      description:
        'Thêm một dòng mới vào cuối một sheet/tab. Truyền các giá trị của dòng theo đúng thứ tự cột.',
      inputSchema: {
        sheetName: z.string().describe("Tên tab, ví dụ 'Sheet1'."),
        values: z
          .array(z.union([z.string(), z.number()]))
          .describe("Giá trị từng cột theo thứ tự, ví dụ ['2026-09-12', 'Mua dây', 500000].")
      }
    },
    async ({ sheetName, values }) => {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] }
      });
      return {
        content: [{ type: 'text', text: `Đã thêm 1 dòng vào ${sheetName}.` }]
      };
    }
  );

  server.registerTool(
    'update_range',
    {
      description: 'Ghi đè giá trị vào một vùng ô cụ thể đã tồn tại (sửa dữ liệu).',
      inputSchema: {
        range: z.string().describe("Vùng A1 cần ghi, ví dụ 'Sheet1!B3:B3'."),
        values: z
          .array(z.array(z.union([z.string(), z.number()])))
          .describe('Mảng 2 chiều các dòng/cột giá trị mới, ví dụ [["Đã xong"]].')
      }
    },
    async ({ range, values }) => {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      return {
        content: [{ type: 'text', text: `Đã cập nhật vùng ${range}.` }]
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring (stateless — new McpServer + transport per request, standard
// pattern for public/remote MCP servers)
// ---------------------------------------------------------------------------
const app = createMcpExpressApp({ host: '0.0.0.0' });

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers['authorization'] || '';
  if (header === `Bearer ${AUTH_TOKEN}`) return true;
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
  return false;
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error('Error handling MCP request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.get('/mcp', (req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    })
  );
});

app.delete('/mcp', (req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    })
  );
});

app.get('/', (req, res) => res.send('Google Sheets MCP server is running.'));

app.listen(PORT, () => {
  console.log(`Google Sheets MCP server listening on port ${PORT}`);
});
