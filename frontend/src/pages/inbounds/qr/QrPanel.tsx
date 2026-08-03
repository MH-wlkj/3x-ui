import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, QRCode, Tag, Tooltip, message } from 'antd';
import { CopyOutlined, DownloadOutlined, PictureOutlined } from '@ant-design/icons';

import { ClipboardManager, FileManager } from '@/utils';
import { activateOnKey } from '@/utils/a11y';
import { qrPngBlob } from '@/lib/qr/png';
import './QrPanel.css';

interface QrPanelProps {
  value: string;
  remark?: string;
  downloadName?: string;
  size?: number;
  showQr?: boolean;
}

function downloadImageBlob(blob: Blob, remark: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${remark || 'qrcode'}.png`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function QrPanel({
  value,
  remark = '',
  downloadName = '',
  size = 360,
  showQr = true,
}: QrPanelProps) {
  const { t } = useTranslation();
  const [messageApi, messageContextHolder] = message.useMessage();
  const qrRef = useRef<HTMLDivElement | null>(null);

  async function copy() {
    const ok = await ClipboardManager.copyText(value);
    if (ok) messageApi.success(t('copied'));
  }

  function download() {
    if (!downloadName) return;
    FileManager.downloadTextFile(value, downloadName);
  }

  async function copyImage() {
    const svgEl = qrRef.current?.querySelector('svg') as SVGSVGElement | null;
    const blob = await qrPngBlob(svgEl, remark, size);
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      messageApi.success(t('copied'));
    } catch {
      downloadImageBlob(blob, remark);
    }
  }

  async function downloadImage() {
    const svgEl = qrRef.current?.querySelector('svg') as SVGSVGElement | null;
    const blob = await qrPngBlob(svgEl, remark, size);
    if (blob) downloadImageBlob(blob, remark);
  }

  return (
    <div className="qr-panel">
      {messageContextHolder}
      <div className="qr-panel-header">
        <Tag color="green" className="qr-remark">{remark}</Tag>
        <Tooltip title={t('copy')}>
          <Button size="small" icon={<CopyOutlined />} aria-label={t('copy')} onClick={copy} />
        </Tooltip>
        {showQr && (
          <Tooltip title={t('downloadImage')}>
            <Button size="small" icon={<PictureOutlined />} aria-label={t('downloadImage')} onClick={downloadImage} />
          </Tooltip>
        )}
        {downloadName && (
          <Tooltip title={t('download')}>
            <Button size="small" icon={<DownloadOutlined />} aria-label={t('download')} onClick={download} />
          </Tooltip>
        )}
      </div>
      {showQr && (
        <div
          ref={qrRef}
          className="qr-panel-canvas"
          role="button"
          tabIndex={0}
          aria-label={t('copy')}
          onClick={copyImage}
          onKeyDown={activateOnKey(copyImage)}
        >
          <Tooltip title={t('copy')}>
            <QRCode
              className="qr-code"
              value={value}
              size={size}
              type="svg"
              bordered={false}
              color="#000000"
              bgColor="#ffffff"
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
}
