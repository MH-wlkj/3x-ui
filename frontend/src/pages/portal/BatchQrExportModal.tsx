import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { qrPngDataUrl } from '@/lib/qr/png';

interface BatchQrExportModalProps {
  open: boolean;
  emails: string[];
  authHeaders: (extra?: Record<string, string>) => { headers: Record<string, string> };
  onOpenChange: (open: boolean) => void;
}

interface ClientLinkRow {
  key: string;
  email: string;
  links: string[];
  loading: boolean;
  error?: string;
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
  authHeaders,
  onOpenChange,
}: BatchQrExportModalProps) {
  const [messageApi, messageContextHolder] = message.useMessage();
  const [rows, setRows] = useState<ClientLinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const qrRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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
      links: [],
      loading: true,
    }));
    setRows(initialRows);

    (async () => {
      const results = await Promise.allSettled(
        emails.map(async (email) => {
          const msg = await HttpUtil.get<string[]>(
            `/portal/api/clients/links/${encodeURIComponent(email)}`,
            undefined,
            { ...authHeaders(), silent: true },
          );
          if (!msg?.success || !Array.isArray(msg.obj)) {
            throw new Error(msg?.msg ?? '获取链接失败');
          }
          return { email, links: msg.obj };
        }),
      );
      if (cancelled) return;
      const updatedRows: ClientLinkRow[] = emails.map((email, idx) => {
        const result = results[idx];
        if (result.status === 'fulfilled') {
          return { key: email, email, links: result.value.links, loading: false };
        }
        return { key: email, email, links: [], loading: false, error: result.reason?.message ?? '获取失败' };
      });
      setRows(updatedRows);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [open, emails, authHeaders]);

  const allText = useMemo(() => rows.flatMap((r) => r.links).join('\n'), [rows]);

  const setQrRef = useCallback((email: string, el: HTMLDivElement | null) => {
    if (el) qrRefs.current.set(email, el);
    else qrRefs.current.delete(email);
  }, []);

  async function copy(text: string, label?: string) {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success(label || '已复制');
    } catch {
      messageApi.error('复制失败');
    }
  }

  async function collectQrDataUrls(): Promise<Map<string, string>> {
    const qrDataUrls = new Map<string, string>();
    for (const row of rows) {
      if (row.links.length === 0) continue;
      const container = qrRefs.current.get(row.email);
      if (!container) continue;
      const svgEl = container.querySelector('svg') as SVGSVGElement | null;
      if (!svgEl) continue;
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      const dataUrl = await qrPngDataUrl(clone, row.email, 150);
      if (dataUrl) qrDataUrls.set(row.email, dataUrl);
    }
    return qrDataUrls;
  }

  async function exportAsXlsx() {
    setExporting(true);
    try {
      const qrDataUrls = await collectQrDataUrls();
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
<thead><tr><th>邮箱</th><th>链接</th><th>二维码</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</body></html>`;
      const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `portal-links-${stamp}.xls`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      messageApi.success('已导出 xlsx 文件');
    } catch {
      messageApi.error('导出失败');
    } finally {
      setExporting(false);
    }
  }

  async function exportAsHtml() {
    setExporting(true);
    try {
      const qrDataUrls = await collectQrDataUrls();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rowsHtml = rows
        .map((r) => {
          const qrImg = qrDataUrls.has(r.email)
            ? `<img src="${qrDataUrls.get(r.email)}" alt="QR" width="120" height="120" style="display:block;margin:4px auto" />`
            : '';
          const linksHtml = r.links
            .map((link) => `<tr><td class="proto-tag">${escapeHtml(protocolFromLink(link))}</td><td><code>${escapeHtml(link)}</code></td></tr>`)
            .join('\n');
          return `<tr><td class="email-cell"><strong>${escapeHtml(r.email)}</strong></td><td class="qr-cell">${qrImg}</td><td class="links-cell"><table class="inner-table">${linksHtml}</table></td></tr>`;
        })
        .join('\n');
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>批量二维码导出 - ${stamp}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px;background:#f5f5f5;color:#333}
h1{font-size:20px;margin-bottom:16px;color:#1677ff}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
th{background:#fafafa;padding:10px 14px;text-align:left;font-weight:600;font-size:13px;border-bottom:2px solid #e8e8e8}
td{padding:12px 14px;border-bottom:1px solid #f0f0f0;vertical-align:top}
.email-cell{min-width:160px}.qr-cell{width:140px;text-align:center}
.inner-table{width:100%;border-collapse:collapse;background:transparent}
.inner-table td{padding:4px 8px;border:none;font-size:12px}
.proto-tag{width:80px;color:#1677ff;font-weight:600;font-size:11px;text-transform:uppercase}
code{word-break:break-all;font-size:11px;color:#555}
</style></head><body>
<h1>批量二维码导出</h1><table>
<thead><tr><th>邮箱</th><th>二维码</th><th>链接</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></body></html>`;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `portal-qr-${stamp}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      messageApi.success('已导出 HTML');
    } catch {
      messageApi.error('导出失败');
    } finally {
      setExporting(false);
    }
  }

  const columns: TableColumnType<ClientLinkRow>[] = useMemo(
    () => [
      {
        title: '邮箱',
        dataIndex: 'email',
        key: 'email',
        width: 180,
        ellipsis: true,
      },
      {
        title: '链接',
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
                      <Typography.Text copyable={{ text: link }} style={{ fontSize: 12, fontFamily: 'monospace' }} ellipsis>
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
          return (
            <div ref={(el) => setQrRef(record.email, el)} style={{ display: 'flex', justifyContent: 'center' }}>
              <QRCode value={record.links[0]} size={80} type="svg" bordered={false} color="#000000" bgColor="#ffffff" />
            </div>
          );
        },
      },
    ],
    [setQrRef],
  );

  const hasLinks = rows.some((r) => r.links.length > 0);

  return (
    <>
      {messageContextHolder}
      <Modal
        open={open}
        title={`批量导出二维码 / 链接（${rows.length} 个客户端）`}
        width={900}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => onOpenChange(false)}>关闭</Button>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button icon={<CopyOutlined />} disabled={!hasLinks} onClick={() => copy(allText, '已复制全部链接')}>
                复制全部链接
              </Button>
              <Button icon={<FileTextOutlined />} disabled={!hasLinks} loading={exporting} onClick={() => void exportAsXlsx()}>
                导出 xlsx
              </Button>
              <Button type="primary" icon={<TableOutlined />} disabled={!hasLinks} onClick={() => void exportAsHtml()}>
                导出 HTML
              </Button>
            </div>
          </div>
        }
        onCancel={() => onOpenChange(false)}
      >
        <Spin spinning={loading}>
          {!loading && rows.length > 0 && !hasLinks && (
            <Alert type="info" showIcon message="所选客户端均无可导出的链接（可能订阅未开启或入站不支持分享链接）。" style={{ marginBottom: 12 }} />
          )}
          <Table<ClientLinkRow>
            rowKey="email"
            columns={columns}
            dataSource={rows}
            size="small"
            pagination={false}
            scroll={{ y: 420 }}
            locale={{ emptyText: '请先选择客户端' }}
          />
        </Spin>
      </Modal>
    </>
  );
}
