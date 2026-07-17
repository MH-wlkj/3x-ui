import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Modal,
  QRCode,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { TableColumnType } from 'antd';
import {
  CopyOutlined,
  FileTextOutlined,
  QrcodeOutlined,
  TableOutlined,
} from '@ant-design/icons';

import { HttpUtil } from '@/utils';
import type { ClientRecord } from '@/hooks/useClients';

interface BatchQrExportModalProps {
  open: boolean;
  emails: string[];
  clients: ClientRecord[];
  onOpenChange: (open: boolean) => void;
}

interface ClientLinkRow {
  key: string;
  email: string;
  subId: string;
  links: string[];
  loading: boolean;
  error?: string;
}

async function svgToDataUrl(svgEl: SVGSVGElement | null, size: number): Promise<string> {
  if (!svgEl) return '';
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve('');
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/png');
      resolve(dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('');
    };
    img.src = url;
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function protocolFromLink(link: string): string {
  const idx = link.indexOf('://');
  if (idx === -1) return '';
  return link.slice(0, idx);
}

export default function BatchQrExportModal({
  open,
  emails,
  clients,
  onOpenChange,
}: BatchQrExportModalProps) {
  const { t } = useTranslation();
  const [messageApi, messageContextHolder] = message.useMessage();
  const [rows, setRows] = useState<ClientLinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const qrRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const byEmail = useMemo(
    () => new Map(clients.map((c) => [c.email, c])),
    [clients],
  );

  // Fetch links for each selected client
  useEffect(() => {
    if (!open || emails.length === 0) {
      setRows([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const initialRows: ClientLinkRow[] = emails.map((email) => ({
      key: email,
      email,
      subId: byEmail.get(email)?.subId ?? '',
      links: [],
      loading: true,
    }));
    setRows(initialRows);

    (async () => {
      const results = await Promise.allSettled(
        emails.map(async (email) => {
          const msg = await HttpUtil.get(
            `/panel/api/clients/links/${encodeURIComponent(email)}`,
          ) as { success?: boolean; msg?: string; obj?: string[] };
          if (!msg?.success || !Array.isArray(msg.obj)) {
            throw new Error(msg?.msg ?? 'Failed to fetch links');
          }
          return { email, links: msg.obj };
        }),
      );

      if (cancelled) return;

      const updatedRows: ClientLinkRow[] = emails.map((email, idx) => {
        const result = results[idx];
        if (result.status === 'fulfilled') {
          return {
            key: email,
            email,
            subId: byEmail.get(email)?.subId ?? '',
            links: result.value.links,
            loading: false,
          };
        }
        return {
          key: email,
          email,
          subId: byEmail.get(email)?.subId ?? '',
          links: [],
          loading: false,
          error: result.reason?.message ?? t('somethingWentWrong'),
        };
      });
      setRows(updatedRows);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [open, emails, byEmail, t]);


  // Build plain links text for clipboard (just URLs, one per line)
  const allText = useMemo(() => {
    return rows
      .flatMap((r) => r.links)
      .join('\n');
  }, [rows]);

  const setQrRef = useCallback((email: string, el: HTMLDivElement | null) => {
    if (el) {
      qrRefs.current.set(email, el);
    } else {
      qrRefs.current.delete(email);
    }
  }, []);

  async function copy(text: string, label?: string) {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success(label || t('copied'));
    } catch {
      messageApi.error(t('somethingWentWrong'));
    }
  }

  async function exportAsHtml() {
    setExportingHtml(true);
    try {
      // Collect QR code data URLs from rendered components
      const qrDataUrls = new Map<string, string>();
      for (const row of rows) {
        if (row.links.length === 0) continue;
        const container = qrRefs.current.get(row.email);
        if (!container) continue;
        const svgEl = container.querySelector('svg') as SVGSVGElement | null;
        if (!svgEl) continue;
        // Clone to avoid mutating the rendered element
        const clone = svgEl.cloneNode(true) as SVGSVGElement;
        const dataUrl = await svgToDataUrl(clone, 200);
        if (dataUrl) qrDataUrls.set(row.email, dataUrl);
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rowsHtml = rows
        .map((r) => {
          const qrImg = qrDataUrls.has(r.email)
            ? `<img src="${qrDataUrls.get(r.email)}" alt="QR" width="120" height="120" style="display:block;margin:4px auto" />`
            : '';
          const linksHtml = r.links
            .map((link) => {
              const proto = protocolFromLink(link);
              return `<tr class="link-row">
                <td class="proto-tag">${escapeHtml(proto)}</td>
                <td><code>${escapeHtml(link)}</code></td>
              </tr>`;
            })
            .join('\n');
          const subIdHtml = r.subId
            ? `<span class="sub-id">${escapeHtml(r.subId)}</span>`
            : '';
          return `<tr>
            <td class="email-cell">
              <strong>${escapeHtml(r.email)}</strong>
              ${subIdHtml}
            </td>
            <td class="qr-cell">${qrImg}</td>
            <td class="links-cell">
              <table class="inner-table">${linksHtml}</table>
            </td>
          </tr>`;
        })
        .join('\n');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Batch QR Export - ${stamp}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; background: #f5f5f5; color: #333; }
  h1 { font-size: 20px; margin-bottom: 16px; color: #1677ff; }
  .meta { font-size: 13px; color: #888; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  th { background: #fafafa; padding: 10px 14px; text-align: left; font-weight: 600; font-size: 13px; border-bottom: 2px solid #e8e8e8; }
  td { padding: 12px 14px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .email-cell { min-width: 160px; }
  .email-cell strong { font-size: 14px; }
  .sub-id { display: inline-block; margin-top: 4px; font-size: 11px; color: #888; background: #f0f0f0; padding: 1px 6px; border-radius: 3px; }
  .qr-cell { width: 140px; text-align: center; }
  .links-cell { }
  .inner-table { width: 100%; border-collapse: collapse; background: transparent; box-shadow: none; }
  .inner-table td { padding: 4px 8px; border: none; font-size: 12px; }
  .inner-table tr:not(:last-child) td { border-bottom: 1px dashed #eee; }
  .proto-tag { width: 80px; color: #1677ff; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  code { word-break: break-all; font-size: 11px; color: #555; }
  @media print { body { padding: 8px; background: #fff; } table { box-shadow: none; } }
</style>
</head>
<body>
<h1>📋 Batch QR Export</h1>
<div class="meta">Exported: ${stamp} • ${rows.length} clients • ${rows.reduce((s, r) => s + r.links.length, 0)} links</div>
<table>
<thead><tr>
  <th>${escapeHtml(t('pages.clients.client'))}</th>
  <th>QR Code</th>
  <th>${escapeHtml(t('pages.clients.links'))}</th>
</tr></thead>
<tbody>
${rowsHtml}
</tbody>
</table>
</body>
</html>`;

      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-qr-export-${stamp}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      messageApi.success(t('pages.clients.batchQrExported'));
    } catch {
      messageApi.error(t('somethingWentWrong'));
    } finally {
      setExportingHtml(false);
    }
  }

  async function exportAsXlsx() {
    setExportingHtml(true);
    try {
      // Collect QR code data URLs from rendered components
      const qrDataUrls = new Map<string, string>();
      for (const row of rows) {
        if (row.links.length === 0) continue;
        const container = qrRefs.current.get(row.email);
        if (!container) continue;
        const svgEl = container.querySelector('svg') as SVGSVGElement | null;
        if (!svgEl) continue;
        const clone = svgEl.cloneNode(true) as SVGSVGElement;
        const dataUrl = await svgToDataUrl(clone, 150);
        if (dataUrl) qrDataUrls.set(row.email, dataUrl);
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tableRows = rows
        .filter((r) => r.links.length > 0)
        .map((r) => {
          const linksText = r.links.join('\n');
          const qrImg = qrDataUrls.has(r.email)
            ? `<img src="${qrDataUrls.get(r.email)}" alt="QR" width="100" height="100" />`
            : '';
          return `<tr>
            <td style="padding:8px;border:1px solid #ccc;vertical-align:top;white-space:nowrap">${escapeHtml(r.email)}</td>
            <td style="padding:8px;border:1px solid #ccc;vertical-align:top;word-break:break-all;font-size:11px">${escapeHtml(linksText)}</td>
            <td style="padding:8px;border:1px solid #ccc;text-align:center;vertical-align:middle">${qrImg}</td>
          </tr>`;
        })
        .join('\n');

      // Generate an HTML table saved as .xls — Excel opens it natively
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Export</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
th { background:#4472c4; color:#fff; padding:10px 12px; font-size:13px; border:1px solid #4472c4; }
td { padding:8px; border:1px solid #ccc; vertical-align:top; }
</style>
</head><body>
<table>
<thead><tr>
  <th>名字</th>
  <th>链接</th>
  <th>二维码</th>
</tr></thead>
<tbody>
${tableRows}
</tbody>
</table>
</body></html>`;

      const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `batch-links-${stamp}.xls`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      messageApi.success(t('pages.clients.batchQrExported'));
    } catch {
      messageApi.error(t('somethingWentWrong'));
    } finally {
      setExportingHtml(false);
    }
  }

  const columns: TableColumnType<ClientLinkRow>[] = useMemo(
    () => [
      {
        title: t('pages.clients.client'),
        dataIndex: 'email',
        key: 'email',
        width: 180,
        ellipsis: true,
        render: (_v, record) => (
          <div>
            <div style={{ fontWeight: 500 }}>{record.email}</div>
            {record.subId && (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, fontFamily: 'monospace' }}
                ellipsis
              >
                {record.subId}
              </Typography.Text>
            )}
          </div>
        ),
      },
      {
        title: t('pages.clients.links'),
        key: 'links',
        ellipsis: true,
        render: (_v, record) => {
          if (record.loading) return <Spin size="small" />;
          if (record.error) return <Typography.Text type="danger">{record.error}</Typography.Text>;
          if (record.links.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {record.links.map((link, i) => {
                const proto = protocolFromLink(link);
                return (
                  <Tooltip key={i} title={link} placement="topLeft">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {proto && (
                        <Tag color="blue" style={{ margin: 0, fontSize: 10, lineHeight: '16px', flexShrink: 0 }}>
                          {proto}
                        </Tag>
                      )}
                      <Typography.Text
                        copyable={{ text: link }}
                        style={{ fontSize: 12, fontFamily: 'monospace' }}
                        ellipsis
                      >
                        {link}
                      </Typography.Text>
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          );
        },
      },
      {
        title: <QrcodeOutlined />,
        key: 'qr',
        width: 100,
        align: 'center',
        render: (_v, record) => {
          if (record.loading || record.error || record.links.length === 0) return null;
          // Show QR for the first link
          const link = record.links[0];
          return (
            <div
              ref={(el) => setQrRef(record.email, el)}
              style={{ display: 'flex', justifyContent: 'center' }}
            >
              <QRCode
                value={link}
                size={80}
                type="svg"
                bordered={false}
                color="#000000"
                bgColor="#ffffff"
              />
            </div>
          );
        },
      },
    ],
    [t, setQrRef],
  );

  const hasLinks = rows.some((r) => r.links.length > 0);
  const hasAny = rows.length > 0;

  return (
    <>
      {messageContextHolder}
      <Modal
        open={open}
        title={t('pages.clients.batchQrTitle', { count: rows.length })}
        width={900}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                icon={<CopyOutlined />}
                disabled={!hasLinks}
                onClick={() => copy(allText, t('copied'))}
              >
                {t('pages.clients.batchQrCopyLinks')}
              </Button>
              <Button
                icon={<FileTextOutlined />}
                disabled={!hasLinks}
                loading={exportingHtml}
                onClick={exportAsXlsx}
              >
                {t('pages.clients.batchQrExportXlsx')}
              </Button>
              <Button
                type="primary"
                icon={<TableOutlined />}
                disabled={!hasLinks}
                onClick={exportAsHtml}
              >
                {t('pages.clients.batchQrExportHtml')}
              </Button>
            </div>
          </div>
        }
        onCancel={() => onOpenChange(false)}
      >
        <Spin spinning={loading} tip={t('loading')}>
          {loading && rows.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center' }} />
          )}
          {!loading && rows.length > 0 && !hasLinks && (
            <Alert
              type="info"
              showIcon
              message={t('pages.clients.batchQrEmptyLinks')}
              style={{ marginBottom: 12 }}
            />
          )}
          {!loading && rows.length === 0 && (
            <Alert
              type="info"
              showIcon
              message={t('pages.clients.batchQrEmptySelection')}
              style={{ marginBottom: 12 }}
            />
          )}
          {hasAny && (
            <Table<ClientLinkRow>
              dataSource={rows}
              columns={columns}
              size="small"
              pagination={false}
              scroll={{ y: 400 }}
              locale={{
                emptyText: t('noData'),
              }}
            />
          )}
        </Spin>
      </Modal>
    </>
  );
}
