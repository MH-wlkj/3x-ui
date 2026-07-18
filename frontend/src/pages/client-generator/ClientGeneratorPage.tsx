import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Col,
  Collapse,
  ConfigProvider,
  Form,
  Input,
  InputNumber,
  Layout,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CopyOutlined,
  EyeOutlined,
  SendOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { ClipboardManager, HttpUtil, RandomUtil, SizeFormatter } from '@/utils';
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } } as const;
import { useTheme } from '@/hooks/useTheme';
import AppSidebar from '@/layouts/AppSidebar';
import '@/styles/page-shell.css';
import '@/styles/page-cards.css';
import '@/styles/utils.css';

const { TextArea } = Input;
const { Title, Text } = Typography;

// ─── Types ────────────────────────────────────────────────────────────

interface NodeLine {
  ip: string;
  port: number;
  user: string;
  pass: string;
  customPrefix?: string;
  remark?: string;
}

interface ClientPayload {
  client: {
    id: string;
    security: string;
    password: string;
    auth: string;
    email: string;
    limitIp: number;
    totalGB: number;
    expiryTime: number;
    enable: boolean;
    tgId: number;
    subId: string;
  };
  inboundIds: number[];
}

interface InboundOption {
  id: number;
  remark?: string;
  tag?: string;
  protocol?: string;
  port?: number;
  nodeId?: number | null;
}

interface PreviewRow {
  key: string;
  email: string;
  nodeAddr: string;
  nodePort: number;
  nodeUser: string;
  protocol: string;
  traffic: string;
  inboundLabel: string;
}

interface GeneratorFormValues {
  nodeInput: string;
  emailPrefix: string;
  emailSuffix: string;
  totalGB: number;
  inboundId: number;
  namingMode: 'ip' | 'seq';
  startNum: number;
  padLength: number;
  outboundProtocol: 'socks' | 'http';
}

const DEFAULT_VALUES: GeneratorFormValues = {
  nodeInput: '',
  emailPrefix: 'MZ1-',
  emailSuffix: '',
  totalGB: 0,
  inboundId: 0,
  namingMode: 'ip',
  startNum: 1,
  padLength: 2,
  outboundProtocol: 'socks',
};

function parseNodes(text: string): NodeLine[] {
  const lines = text.split('\n');
  const nodes: NodeLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    // 5段格式: 前缀:IP:端口:账号:密码
    if (parts.length >= 5) {
      nodes.push({
        customPrefix: parts[0],
        ip: parts[1],
        port: parseInt(parts[2], 10),
        user: parts[3],
        pass: parts.slice(4).join(':'),
        remark: parts[0],
      });
    // 4段格式: IP:端口:账号:密码
    } else if (parts.length >= 4) {
      nodes.push({
        ip: parts[0],
        port: parseInt(parts[1], 10),
        user: parts[2],
        pass: parts.slice(3).join(':'),
      });
    }
  }
  return nodes;
}

function formatInboundLabel(ib: InboundOption): string {
  const proto = ib.protocol || '?';
  const label = ib.remark || ib.tag || `#${ib.id}`;
  const port = ib.port ? `:${ib.port}` : '';
  return `${proto} | ${label}${port}`;
}

export default function ClientGeneratorPage() {
  const { t: _t } = useTranslation();
  const { isDark, isUltra, antdThemeConfig } = useTheme();
  const [messageApi, messageContextHolder] = message.useMessage();

  const [formValues, setFormValues] = useState<GeneratorFormValues>(DEFAULT_VALUES);
  const [namingMode, setNamingMode] = useState<'ip' | 'seq'>('ip');

  const [inbounds, setInbounds] = useState<InboundOption[]>([]);
  const [inboundsLoading, setInboundsLoading] = useState(false);
  const [parsedNodes, setParsedNodes] = useState<NodeLine[]>([]);

  const [clientsJson, setClientsJson] = useState('');
  const [outboundsJson, setOutboundsJson] = useState('');
  const [routingJson, setRoutingJson] = useState('');
  const [generated, setGenerated] = useState(false);
  const [count, setCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deployResult, setDeployResult] = useState<{ success: boolean; msg: string; created?: number } | null>(null);

  const pageClass = useMemo(() => {
    const classes = ['client-generator-page'];
    if (isDark) classes.push('is-dark');
    if (isUltra) classes.push('is-ultra');
    return classes.join(' ');
  }, [isDark, isUltra]);

  // ── 自动加载入站列表 ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setInboundsLoading(true);
    (async () => {
      try {
        const msg = await HttpUtil.get('/panel/api/inbounds/options', undefined, { silent: true }) as {
          success?: boolean; obj?: InboundOption[];
        };
        if (!cancelled && msg?.success && Array.isArray(msg.obj)) {
          setInbounds(msg.obj!);
          // 自动选中第一个入站
          setFormValues((prev) => {
            if (prev.inboundId === 0 && msg.obj!.length > 0) {
              return { ...prev, inboundId: msg.obj![0].id };
            }
            return prev;
          });
        }
      } finally {
        if (!cancelled) setInboundsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedInbound = useMemo(
    () => inbounds.find((ib) => ib.id === formValues.inboundId),
    [inbounds, formValues.inboundId],
  );

  // Determine if the selected inbound belongs to a sub-node
  const selectedNodeId = useMemo(
    () => (selectedInbound as { nodeId?: number | null })?.nodeId ?? null,
    [selectedInbound],
  );

  // ── 输入节点时实时解析 ──────────────────────────────────────────
  const onNodeInputChange = useCallback((value: string) => {
    setFormValues((prev) => ({ ...prev, nodeInput: value }));
    const nodes = parseNodes(value);
    setParsedNodes(nodes);
  }, []);

  // ── 生成 ─────────────────────────────────────────────────────────
  const onGenerate = useCallback(() => {
    const nodes = parsedNodes;

    if (nodes.length === 0) {
      messageApi.error('请先输入有效的节点列表（格式：IP:端口:账号:密码）');
      return;
    }

    if (!selectedInbound) {
      messageApi.error('请选择一个目标入站');
      return;
    }

    const clients: ClientPayload[] = [];
    const outbounds: unknown[] = [];
    const routing: unknown[] = [];
    let currentNum = formValues.startNum;

    for (const node of nodes) {
      let emailName: string;
      if (formValues.namingMode === 'seq') {
        let numStr = currentNum.toString();
        while (numStr.length < formValues.padLength) numStr = '0' + numStr;
        emailName = `${formValues.emailPrefix}${numStr}${formValues.emailSuffix}`;
        currentNum++;
      } else if (node.customPrefix) {
        emailName = `${node.customPrefix}${node.ip}${formValues.emailSuffix}`;
      } else {
        emailName = `${formValues.emailPrefix}${node.ip}${formValues.emailSuffix}`;
      }

      clients.push({
        client: {
          id: RandomUtil.randomUUID(),
          security: 'auto',
          password: RandomUtil.randomLowerAndNum(16),
          auth: RandomUtil.randomLowerAndNum(16),
          email: emailName,
          limitIp: 0,
          totalGB: Math.round(formValues.totalGB * SizeFormatter.ONE_GB),
          expiryTime: 0,
          enable: true,
          tgId: 0,
          subId: RandomUtil.randomLowerAndNum(16),
        },
        inboundIds: [formValues.inboundId],
      });

      const proto = formValues.outboundProtocol;
      outbounds.push({
        tag: emailName,
        protocol: proto,
        settings: {
          servers: [{
            address: node.ip,
            port: node.port,
            users: [{ user: node.user, pass: node.pass }],
          }],
        },
      });

      routing.push({
        type: 'field',
        user: [emailName],
        outboundTag: emailName,
      });
    }

    setClientsJson(JSON.stringify(clients, null, 2));
    setOutboundsJson(JSON.stringify(outbounds, null, 2));
    setRoutingJson(JSON.stringify(routing, null, 2));
    setCount(nodes.length);
    setGenerated(true);
    setDeployResult(null);
    messageApi.success(`✅ 生成成功！共 ${nodes.length} 个节点`);
  }, [parsedNodes, formValues, selectedInbound, messageApi]);

  // ── 复制 ─────────────────────────────────────────────────────────
  const onCopy = useCallback(async (text: string, label: string) => {
    const ok = await ClipboardManager.copyText(text);
    if (ok) {
      messageApi.success(`${label} 已复制`);
    } else {
      messageApi.error('复制失败，请手动选择复制');
    }
  }, [messageApi]);

  // ── 一键部署 ──────────────────────────────────────────────────────
  const onDeploy = useCallback(async () => {
    if (!clientsJson) return;
    setSubmitting(true);
    setDeployResult(null);

    // Build the Xray config API paths — use node proxy if target is a sub-node
    const isNode = !!selectedNodeId;
    const nodePrefix = isNode ? `/panel/api/node/${selectedNodeId}/xray` : '';
    const getConfigUrl = isNode ? `${nodePrefix}` : '/panel/api/xray/';
    const updateConfigUrl = isNode ? `${nodePrefix}/update` : '/panel/api/xray/update';
    const restartUrl = isNode ? `${nodePrefix}/restart` : '/panel/api/server/restartXrayService';

    try {
      const payloads = JSON.parse(clientsJson) as ClientPayload[];
      const outbounds = (() => {
        try { return JSON.parse(outboundsJson); } catch { return []; }
      })();
      const routing = (() => {
        try { return JSON.parse(routingJson); } catch { return []; }
      })();

      if (outbounds.length === 0) {
        messageApi.warning('⚠️ 出站规则为空，将只创建客户端');
      }

      // Step 1: Bulk create clients
      const msg = await HttpUtil.post('/panel/api/clients/bulkCreate', payloads, JSON_HEADERS);
      const result = msg?.obj as { created?: number; skipped?: { email?: string; reason?: string }[] } | undefined;
      const created = result?.created ?? 0;
      const skipped = result?.skipped ?? [];

      if (!msg?.success) {
        setDeployResult({ success: false, msg: msg?.msg || '部署失败' });
        messageApi.error(`部署失败：${msg?.msg || '未知错误'}`);
        setSubmitting(false);
        return;
      }

      setDeployResult({
        success: true,
        msg: `成功创建 ${created} 个客户端${skipped.length > 0 ? `，${skipped.length} 个跳过` : ''}`,
        created,
      });
      messageApi.success(`✅ 已创建 ${created} 个客户端！`);

      // Step 2: Add outbounds and routing rules to Xray config
      if (outbounds.length > 0 || routing.length > 0) {
        const configMsg = await HttpUtil.post(getConfigUrl, undefined, { silent: true });
        if (configMsg?.success && typeof configMsg.obj === 'string') {
          const parsed = JSON.parse(configMsg.obj);
          const settings = parsed.xraySetting as {
            outbounds?: unknown[];
            routing?: { rules?: unknown[] };
          };

          // Collect existing outbound tags from the real config
          const existingTags = new Set(
            (settings.outbounds ?? []).map((o: unknown) => (o as { tag?: string }).tag),
          );

          // Append new outbounds (skip duplicates by tag)
          const addedOutbounds: unknown[] = [];
          for (const ob of outbounds) {
            const tag = (ob as { tag?: string }).tag;
            if (tag && !existingTags.has(tag)) {
              settings.outbounds ??= [];
              settings.outbounds.push(ob);
              addedOutbounds.push(ob);
            }
          }

          // Collect existing routing rule tags for dedup
          settings.routing ??= {};
          settings.routing.rules ??= [];
          const existingRuleTags = new Set(
            (settings.routing.rules ?? []).map((r: unknown) => {
              const rt = r as { outboundTag?: string | string[] };
              return Array.isArray(rt.outboundTag) ? rt.outboundTag[0] : rt.outboundTag;
            }),
          );

          // Append new routing rules (skip duplicates by outboundTag)
          let addedRouting = 0;
          if (routing.length > 0) {
            for (const rule of routing) {
              const rt = rule as { outboundTag?: string | string[] };
              const tag = Array.isArray(rt.outboundTag) ? rt.outboundTag[0] : rt.outboundTag;
              if (tag && !existingRuleTags.has(tag)) {
                settings.routing.rules.push(rule);
                existingRuleTags.add(tag);
                addedRouting++;
              }
            }
          }

          // Save updated config — send only the xraySetting part
          const saveMsg = await HttpUtil.post(updateConfigUrl, {
            xraySetting: JSON.stringify(settings, null, 2),
            outboundTestUrl: (parsed as { outboundTestUrl?: string }).outboundTestUrl || 'https://www.google.com/generate_204',
          });
          if (saveMsg?.success) {
            const parts: string[] = [];
            if (addedOutbounds.length) parts.push(`${addedOutbounds.length} 个出站`);
            if (addedRouting) parts.push(`${addedRouting} 个路由`);
            messageApi.success(`✅ 已添加 ${parts.join('、')} 规则`);
          } else {
            messageApi.warning('⚠️ 客户端已创建，但规则保存失败');
          }
        }
      }

      // Step 3: Restart Xray
      try {
        await HttpUtil.post(`${restartUrl}`);
        messageApi.info('🔄 Xray 配置已重载');
      } catch {
        messageApi.warning('⚠️ 配置已保存，但 Xray 重载失败，请手动重启');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '未知错误';
      setDeployResult({ success: false, msg: errMsg });
      messageApi.error(`部署出错：${errMsg}`);
    } finally {
      setSubmitting(false);
    }
  }, [clientsJson, outboundsJson, routingJson, selectedNodeId, messageApi]);

  const getDeployStatusIcon = () => {
    if (!deployResult) return null;
    return deployResult.success
      ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 24 }} />
      : <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 24 }} />;
  };

  const copyAll = useCallback(async () => {
    const combined = `=== 客户端 JSON ===\n${clientsJson}\n\n=== 出站规则 ===\n${outboundsJson}\n\n=== 路由规则 ===\n${routingJson}`;
    await onCopy(combined, '全部配置');
  }, [clientsJson, outboundsJson, routingJson, onCopy]);

  // ── 预览表格列 ──────────────────────────────────────────────────
  const previewColumns: ColumnsType<PreviewRow> = useMemo(() => [
    {
      title: '#',
      key: 'index',
      width: 50,
      render: (_v, _r, idx) => idx + 1,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      width: 200,
      ellipsis: true,
    },
    {
      title: '上游节点',
      key: 'node',
      width: 200,
      render: (_v, record) => (
        <Text code style={{ fontSize: 12 }}>
          {record.nodeAddr}:{record.nodePort}
        </Text>
      ),
    },
    {
      title: '账号',
      dataIndex: 'nodeUser',
      key: 'nodeUser',
      width: 120,
      ellipsis: true,
    },
    {
      title: '出站协议',
      dataIndex: 'protocol',
      key: 'protocol',
      width: 100,
      render: (p: string) => (
        <Tag color={p === 'socks' ? 'blue' : 'green'}>{p.toUpperCase()}</Tag>
      ),
    },
    {
      title: '流量',
      dataIndex: 'traffic',
      key: 'traffic',
      width: 100,
    },
    {
      title: '目标入站',
      dataIndex: 'inboundLabel',
      key: 'inboundLabel',
      ellipsis: true,
      render: (label: string) => <Tag color="geekblue" style={{ fontSize: 11 }}>{label}</Tag>,
    },
  ], []);

  const previewData = useMemo<PreviewRow[]>(() => {
    if (!generated || parsedNodes.length === 0) return [];
    const inboundLabel = selectedInbound ? formatInboundLabel(selectedInbound) : `#${formValues.inboundId}`;
    const trafficStr = formValues.totalGB > 0 ? `${formValues.totalGB} GB` : '∞';
    return parsedNodes.map((node, idx) => {
      let email: string;
      if (formValues.namingMode === 'seq') {
        let numStr = (formValues.startNum + idx).toString();
        while (numStr.length < formValues.padLength) numStr = '0' + numStr;
        email = `${formValues.emailPrefix}${numStr}${formValues.emailSuffix}`;
      } else if (node.customPrefix) {
        email = `${node.customPrefix}${node.ip}${formValues.emailSuffix}`;
      } else {
        email = `${formValues.emailPrefix}${node.ip}${formValues.emailSuffix}`;
      }
      return {
        key: String(idx),
        email,
        nodeAddr: node.ip,
        nodePort: node.port,
        nodeUser: node.user,
        protocol: formValues.outboundProtocol,
        traffic: trafficStr,
        inboundLabel,
      };
    });
  }, [generated, parsedNodes, selectedInbound, formValues]);

  // ── 节点解析预览列 ──────────────────────────────────────────────
  const nodeColumns: ColumnsType<NodeLine & { key: string }> = useMemo(() => [
    { title: '#', key: 'idx', width: 50, render: (_v, _r, idx) => idx + 1 },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 120,
      ellipsis: true,
      render: (v: string | undefined) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'IP 地址',
      dataIndex: 'ip',
      key: 'ip',
      width: 160,
    },
    {
      title: '端口',
      dataIndex: 'port',
      key: 'port',
      width: 80,
    },
    {
      title: '用户名',
      dataIndex: 'user',
      key: 'user',
      width: 130,
      ellipsis: true,
    },
    {
      title: '密码',
      dataIndex: 'pass',
      key: 'pass',
      ellipsis: true,
      render: (v: string) => (
        <Text code style={{ fontSize: 12 }}>{v.length > 20 ? `${v.slice(0, 20)}…` : v}</Text>
      ),
    },
  ], []);

  // ── 渲染 ─────────────────────────────────────────────────────────
  return (
    <ConfigProvider theme={antdThemeConfig}>
      {messageContextHolder}
      <Layout className={pageClass}>
        <AppSidebar />
        <Layout className="content-shell">
          <Layout.Content className="content-area" style={{ padding: 24 }}>
            <Card style={{ maxWidth: 1200, margin: '0 auto' }}>
              <Title level={4} style={{ textAlign: 'center', marginBottom: 24 }}>
                ⚡ 客户端 + 路由规则 一键生成器
              </Title>

              {/* ── 配置面板 ──────────────────────────────────────── */}
              <Card
                type="inner"
                title="生成配置"
                size="small"
                style={{ marginBottom: 16 }}
              >
                <Row gutter={[16, 12]}>
                  <Col xs={24} sm={12} md={6}>
                    <Form.Item label="Email 前缀" style={{ marginBottom: 0 }}>
                      <Input
                        defaultValue={DEFAULT_VALUES.emailPrefix}
                        onChange={(e) => setFormValues((v) => ({ ...v, emailPrefix: e.target.value }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12} md={6}>
                    <Form.Item label="Email 后缀" style={{ marginBottom: 0 }}>
                      <Input
                        defaultValue={DEFAULT_VALUES.emailSuffix}
                        onChange={(e) => setFormValues((v) => ({ ...v, emailSuffix: e.target.value }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12} md={6}>
                    <Form.Item label="流量限制 (GB)" style={{ marginBottom: 0 }}>
                      <InputNumber
                        style={{ width: '100%' }}
                        min={0}
                        defaultValue={DEFAULT_VALUES.totalGB}
                        onChange={(v) => setFormValues((prev) => ({ ...prev, totalGB: v || 0 }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={12} md={6}>
                    <Form.Item label="目标入站" style={{ marginBottom: 0 }}>
                      <Select
                        style={{ width: '100%' }}
                        loading={inboundsLoading}
                        placeholder="请选择入站"
                        value={formValues.inboundId || undefined}
                        onChange={(v) => setFormValues((prev) => ({ ...prev, inboundId: v }))}
                        options={inbounds.map((ib) => ({
                          value: ib.id,
                          label: formatInboundLabel(ib),
                        }))}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={[16, 12]} style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--color-border, #d9d9d9)' }}>
                  <Col xs={24} sm={6}>
                    <Form.Item label="命名规则" style={{ marginBottom: 0 }}>
                      <select
                        style={{ width: '100%', height: 32, border: '1px solid #d9d9d9', borderRadius: 6, padding: '0 8px' }}
                        defaultValue={DEFAULT_VALUES.namingMode}
                        onChange={(e) => {
                          const val = e.target.value as 'ip' | 'seq';
                          setNamingMode(val);
                          setFormValues((prev) => ({ ...prev, namingMode: val }));
                        }}
                      >
                        <option value="ip">使用 IP 命名</option>
                        <option value="seq">顺序数字命名</option>
                      </select>
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={6}>
                    <Form.Item label="出站协议" style={{ marginBottom: 0 }}>
                      <Select
                        style={{ width: '100%' }}
                        defaultValue={DEFAULT_VALUES.outboundProtocol}
                        onChange={(v) => setFormValues((prev) => ({ ...prev, outboundProtocol: v }))}
                        options={[
                          { value: 'socks', label: 'SOCKS5' },
                          { value: 'http', label: 'HTTP' },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  {namingMode === 'seq' && (
                    <>
                      <Col xs={24} sm={6}>
                        <Form.Item label="起始数字" style={{ marginBottom: 0 }}>
                          <InputNumber
                            style={{ width: '100%' }}
                            min={1}
                            defaultValue={DEFAULT_VALUES.startNum}
                            onChange={(v) => setFormValues((prev) => ({ ...prev, startNum: v || 1 }))}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={24} sm={6}>
                        <Form.Item label="补零位数" style={{ marginBottom: 0 }}>
                          <InputNumber
                            style={{ width: '100%' }}
                            min={1}
                            max={5}
                            defaultValue={DEFAULT_VALUES.padLength}
                            onChange={(v) => setFormValues((prev) => ({ ...prev, padLength: v || 2 }))}
                          />
                        </Form.Item>
                      </Col>
                    </>
                  )}
                </Row>
              </Card>

              {/* ── 节点输入 ──────────────────────────────────────── */}
              <Card
                type="inner"
                title="📥 上游 SK5 节点列表"
                size="small"
                extra={<Text type="secondary">格式: <Text code>前缀:IP:端口:账号:密码</Text> 或 <Text code>IP:端口:账号:密码</Text></Text>}
                style={{ marginBottom: 16 }}
              >
                <TextArea
                  rows={5}
                  placeholder={'香港节点:198.65.65.250:7176:user:pass\n日本节点:198.65.122.168:6808:user:pass\n198.65.123.45:7176:user2:pass2'}
                  onChange={(e) => onNodeInputChange(e.target.value)}
                />
                {parsedNodes.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                      已解析 <Tag color="processing">{parsedNodes.length}</Tag> 个节点：
                    </Text>
                    <Table<NodeLine & { key: string }>
                      dataSource={parsedNodes.map((n, i) => ({ ...n, key: String(i), remark: n.remark || n.customPrefix }))}
                      columns={nodeColumns}
                      size="small"
                      pagination={false}
                      bordered
                    />
                  </div>
                )}
              </Card>

              {/* ── 操作按钮 ──────────────────────────────────────── */}
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col xs={24} sm={generated ? 8 : 12}>
                  <Button
                    type="primary"
                    size="large"
                    icon={<ThunderboltOutlined />}
                    onClick={onGenerate}
                    block
                    style={{ height: 44 }}
                  >
                    🚀 一键生成
                  </Button>
                </Col>
                {generated && (
                  <>
                    <Col xs={12} sm={8}>
                      <Button
                        size="large"
                        icon={<CopyOutlined />}
                        onClick={copyAll}
                        block
                        style={{ height: 44 }}
                      >
                        📋 复制全部
                      </Button>
                    </Col>
                    <Col xs={12} sm={8}>
                      <Button
                        type="primary"
                        size="large"
                        icon={<SendOutlined />}
                        loading={submitting}
                        onClick={onDeploy}
                        block
                        style={{ height: 44 }}
                      >
                        📤 一键部署到面板
                      </Button>
                    </Col>
                  </>
                )}
              </Row>

              {/* ── 部署结果 ──────────────────────────────────────── */}
              {deployResult && (
                <Card
                  size="small"
                  style={{
                    marginBottom: 16,
                    borderColor: deployResult.success ? '#b7eb8f' : '#ffa39e',
                    background: deployResult.success ? '#f6ffed' : '#fff2f0',
                  }}
                >
                  <Space>
                    {getDeployStatusIcon()}
                    <Text strong={deployResult.success}>
                      {deployResult.msg}
                    </Text>
                    {deployResult.created && (
                      <Tag color="success">{deployResult.created} 个客户端</Tag>
                    )}
                  </Space>
                </Card>
              )}

              {/* ── 生成结果 ──────────────────────────────────────── */}
              {generated && (
                <>
                  <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginBottom: 12 }}>
                    已生成 <Tag color="processing">{count}</Tag> 个客户端配置
                  </Text>

                  {/* 表格预览 */}
                  <Card
                    size="small"
                    title={<Space><EyeOutlined /> 生成预览</Space>}
                    style={{ marginBottom: 16 }}
                  >
                    <Table<PreviewRow>
                      dataSource={previewData}
                      columns={previewColumns}
                      size="small"
                      pagination={false}
                      bordered
                    />
                  </Card>

                  {/* 原始 JSON */}
                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={8}>
                      <Card
                        size="small"
                        title={<Space><Tag color="green">1</Tag> 客户端 JSON</Space>}
                        extra={
                          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(clientsJson, '客户端配置')}>
                            复制
                          </Button>
                        }
                      >
                        <TextArea rows={12} value={clientsJson} readOnly style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      </Card>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Card
                        size="small"
                        title={<Space><Tag color="blue">2</Tag> 出站规则</Space>}
                        extra={
                          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(outboundsJson, '出站规则')}>
                            复制
                          </Button>
                        }
                      >
                        <TextArea rows={12} value={outboundsJson} readOnly style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      </Card>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Card
                        size="small"
                        title={<Space><Tag color="purple">3</Tag> 路由规则</Space>}
                        extra={
                          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(routingJson, '路由规则')}>
                            复制
                          </Button>
                        }
                      >
                        <TextArea rows={12} value={routingJson} readOnly style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      </Card>
                    </Col>
                  </Row>

                  <Collapse
                    ghost
                    size="small"
                    style={{ marginTop: 16 }}
                    items={[{
                      key: 'usage',
                      label: '💡 使用说明',
                      children: (
                        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
                          <li><strong>客户端 JSON</strong> — 复制后到 <Text code>面板 → 客户端 → 批量导入</Text> 粘贴</li>
                          <li><strong>出站规则</strong> — 复制到 <Text code>面板 → Xray 配置 → Outbounds</Text> 中合并</li>
                          <li><strong>路由规则</strong> — 复制到 <Text code>面板 → Xray 配置 → Routing</Text> 中合并</li>
                          <li><strong>一键部署</strong> — 自动通过 API 批量创建客户端 + 重载 Xray 配置</li>
                        </ul>
                      ),
                    }]}
                  />
                </>
              )}
            </Card>
          </Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}