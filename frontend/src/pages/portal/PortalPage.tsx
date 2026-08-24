import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  ConfigProvider,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  KeyOutlined,
  LogoutOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import { useTheme } from '@/hooks/useTheme';
import { HttpUtil, SizeFormatter } from '@/utils';
import { setMessageInstance } from '@/utils/messageBus';
import { QrPanel } from '@/pages/inbounds/qr';
import type { InboundOption } from '@/schemas/client';
import type { PortalClientLinks, PortalClientView, UserStatus } from '@/generated/types';
import '@/styles/page-shell.css';
import '@/styles/page-cards.css';
import '@/styles/utils.css';

const { Title, Text } = Typography;
const { TextArea } = Input;
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } } as const;
const TOKEN_KEY = 'portal_token';
const DAY_MS = 86400000;

interface NodeLine {
  ip: string;
  port: number;
  user: string;
  pass: string;
  customPrefix?: string;
}

interface GenValues {
  emailPrefix: string;
  emailSuffix: string;
  totalGB: number;
  expiryDays: number;
  inboundId: number;
  namingMode: 'ip' | 'seq';
  startNum: number;
  padLength: number;
  enableVision: boolean;
}

const DEFAULT_GEN: GenValues = {
  emailPrefix: 'user-',
  emailSuffix: '',
  totalGB: 0,
  expiryDays: 0,
  inboundId: 0,
  namingMode: 'seq',
  startNum: 1,
  padLength: 2,
  enableVision: true,
};

function parseNodes(text: string): NodeLine[] {
  const lines = text.split('\n');
  const nodes: NodeLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length >= 5) {
      nodes.push({
        customPrefix: parts[0],
        ip: parts[1],
        port: parseInt(parts[2], 10),
        user: parts[3],
        pass: parts.slice(4).join(':'),
      });
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

export default function PortalPage() {
  const { isDark, isUltra, antdThemeConfig } = useTheme();
  const [messageApi, messageContextHolder] = message.useMessage();
  useEffect(() => { setMessageInstance(messageApi); }, [messageApi]);

  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || '');
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [inbounds, setInbounds] = useState<InboundOption[]>([]);
  const [clients, setClients] = useState<PortalClientView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  const [genValues, setGenValues] = useState<GenValues>(DEFAULT_GEN);
  const [genNamingMode, setGenNamingMode] = useState<'ip' | 'seq'>('seq');
  const [nodeInput, setNodeInput] = useState('');
  const [parsedNodes, setParsedNodes] = useState<NodeLine[]>([]);
  const [previewEmails, setPreviewEmails] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const prefilledRef = useRef(false);

  const [qrOpen, setQrOpen] = useState(false);
  const [qrClient, setQrClient] = useState<PortalClientView | null>(null);
  const [qrLinks, setQrLinks] = useState<PortalClientLinks | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdForm] = Form.useForm<{ oldPassword: string; newPassword: string }>();

  const authHeaders = useCallback(
    (extra?: Record<string, string>) => ({ headers: { Authorization: `Bearer ${token}`, ...(extra ?? {}) } }),
    [token],
  );

  const loadAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [meMsg, inboundMsg, clientMsg] = await Promise.all([
        HttpUtil.get<UserStatus>('/portal/api/me', undefined, { ...authHeaders(), silent: true }),
        HttpUtil.get<InboundOption[]>('/portal/api/inbounds', undefined, { ...authHeaders(), silent: true }),
        HttpUtil.get<PortalClientView[]>('/portal/api/clients', undefined, { ...authHeaders(), silent: true }),
      ]);
      if (!meMsg?.success) {
        localStorage.removeItem(TOKEN_KEY);
        setToken('');
        setStatus(null);
        return;
      }
      setStatus(meMsg.obj ?? null);
      setInbounds(Array.isArray(inboundMsg.obj) ? inboundMsg.obj : []);
      setClients(Array.isArray(clientMsg.obj) ? clientMsg.obj : []);
      if (meMsg.obj && !prefilledRef.current) {
        prefilledRef.current = true;
        setGenValues((v) => ({ ...v, totalGB: Math.round(meMsg.obj!.trafficLimit / SizeFormatter.ONE_GB) }));
      }
    } finally {
      setLoading(false);
    }
  }, [token, authHeaders]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const doLogin = async (values: { username: string; password: string }) => {
    setLoginLoading(true);
    try {
      const msg = await HttpUtil.post<{ token: string }>('/portal/api/login', values, JSON_HEADERS);
      if (msg?.success && msg.obj?.token) {
        localStorage.setItem(TOKEN_KEY, msg.obj.token);
        setToken(msg.obj.token);
        messageApi.success('登录成功');
      } else {
        messageApi.error(msg?.msg || '登录失败');
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const doLogout = () => {
    void HttpUtil.post('/portal/api/logout', undefined, authHeaders());
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setStatus(null);
    setInbounds([]);
    setClients([]);
  };

  const onNodeInputChange = (value: string) => {
    setNodeInput(value);
    setParsedNodes(parseNodes(value));
  };

  const onGenerate = () => {
    if (parsedNodes.length === 0) {
      messageApi.error('请先输入有效的节点列表（格式：IP:端口:账号:密码）');
      return;
    }
    if (!genValues.inboundId) {
      messageApi.error('请选择一个目标入站');
      return;
    }
    const emails: string[] = [];
    let currentNum = genValues.startNum;
    for (const node of parsedNodes) {
      let email: string;
      if (genValues.namingMode === 'seq') {
        let numStr = currentNum.toString();
        while (numStr.length < genValues.padLength) numStr = '0' + numStr;
        email = `${genValues.emailPrefix}${numStr}${genValues.emailSuffix}`;
        currentNum++;
      } else if (node.customPrefix) {
        email = `${node.customPrefix}${node.ip}${genValues.emailSuffix}`;
      } else {
        email = `${genValues.emailPrefix}${node.ip}${genValues.emailSuffix}`;
      }
      emails.push(email);
    }
    setPreviewEmails(emails);
    messageApi.success(`✅ 已生成 ${emails.length} 个客户端预览`);
  };

  const onCreate = async () => {
    if (previewEmails.length === 0) {
      messageApi.warning('请先生成预览');
      return;
    }
    if (!genValues.inboundId) {
      messageApi.error('请选择一个目标入站');
      return;
    }
    setCreating(true);
    try {
      const targetInbound = inbounds.find((ib) => ib.id === genValues.inboundId);
      const shouldSetFlow = genValues.enableVision && targetInbound?.protocol === 'vless';
      const payload = {
        inboundId: genValues.inboundId,
        clients: previewEmails.map((email) => ({
          email,
          totalGB: Math.round((genValues.totalGB || 0) * SizeFormatter.ONE_GB),
          expiryTime: (genValues.expiryDays || 0) > 0 ? Date.now() + (genValues.expiryDays || 0) * DAY_MS : 0,
          flow: shouldSetFlow ? 'xtls-rprx-vision' : '',
        })),
      };
      const msg = await HttpUtil.post<{ created?: { created?: number; skipped?: unknown[] } }>(
        '/portal/api/clients/bulk',
        payload,
        authHeaders(JSON_HEADERS.headers),
      );
      if (msg?.success) {
        const created = msg.obj?.created?.created ?? previewEmails.length;
        messageApi.success(`✅ 已创建 ${created} 个客户端`);
        setPreviewEmails([]);
        void loadAll();
      } else {
        messageApi.error(msg?.msg || '创建失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const openQr = useCallback(async (row: PortalClientView) => {
    setQrClient(row);
    setQrOpen(true);
    setQrLinks(null);
    setQrLoading(true);
    try {
      const msg = await HttpUtil.get<PortalClientLinks>(
        `/portal/api/clients/links/${encodeURIComponent(row.email)}`,
        undefined,
        { ...authHeaders(), silent: true },
      );
      if (msg?.success) {
        setQrLinks(msg.obj ?? null);
      } else {
        messageApi.error(msg?.msg || '获取链接失败');
      }
    } finally {
      setQrLoading(false);
    }
  }, [authHeaders, messageApi]);

  const deleteClient = useCallback((row: PortalClientView) => {
    Modal.confirm({
      title: `删除客户端 ${row.email}？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const msg = await HttpUtil.post('/portal/api/clients/delete', { email: row.email }, authHeaders(JSON_HEADERS.headers));
        if (msg?.success) {
          messageApi.success('客户端已删除');
          void loadAll();
        } else {
          messageApi.error(msg?.msg || '删除失败');
        }
      },
    });
  }, [authHeaders, loadAll, messageApi]);

  const changePassword = async () => {
    const values = await pwdForm.validateFields();
    setPwdLoading(true);
    try {
      const msg = await HttpUtil.post('/portal/api/password', values, authHeaders(JSON_HEADERS.headers));
      if (msg?.success) {
        messageApi.success('密码已修改');
        setPwdOpen(false);
        pwdForm.resetFields();
      } else {
        messageApi.error(msg?.msg || '修改失败');
      }
    } finally {
      setPwdLoading(false);
    }
  };

  const inboundLabel = useCallback((id: number) => {
    const ib = inbounds.find((x) => x.id === id);
    return ib ? `${ib.protocol || '?'} | ${ib.nodeName || ib.remark || ib.tag || `#${id}`}` : `#${id}`;
  }, [inbounds]);

  const remaining = useMemo(() => {
    if (!status) return null;
    if (status.clientLimit <= 0) return null;
    return Math.max(0, status.clientLimit - status.usedClients);
  }, [status]);

  const columns: TableColumnsType<PortalClientView> = useMemo(() => [
    { title: '邮箱', dataIndex: 'email', key: 'email', ellipsis: true },
    {
      title: '入站',
      dataIndex: 'inboundId',
      key: 'inboundId',
      render: (id: number) => <Tag color="geekblue" style={{ fontSize: 11 }}>{inboundLabel(id)}</Tag>,
    },
    {
      title: '流量',
      key: 'traffic',
      render: (_v, r) => {
        const up = SizeFormatter.sizeFormat(r.up || 0);
        const down = SizeFormatter.sizeFormat(r.down || 0);
        return <Text style={{ fontSize: 12 }}>{up}↑ {down}↓</Text>;
      },
    },
    {
      title: '到期',
      dataIndex: 'expiryTime',
      key: 'expiryTime',
      width: 110,
      render: (v: number) => (v > 0 ? new Date(v).toLocaleDateString() : '永久'),
    },
    {
      title: '状态',
      dataIndex: 'enable',
      key: 'enable',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag color="red">停用</Tag>),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_v, r) => (
        <Space>
          <Button size="small" icon={<QrcodeOutlined />} onClick={() => void openQr(r)}>二维码</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteClient(r)}>删除</Button>
        </Space>
      ),
    },
  ], [inboundLabel, deleteClient, openQr]);

  const pageClass = useMemo(() => {
    const classes = ['portal-page'];
    if (isDark) classes.push('is-dark');
    if (isUltra) classes.push('is-ultra');
    return classes.join(' ');
  }, [isDark, isUltra]);

  if (!token) {
    return (
      <ConfigProvider theme={antdThemeConfig}>
        {messageContextHolder}
        <Layout className={pageClass} style={{ minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Card style={{ width: 380, boxShadow: '0 6px 24px rgba(0,0,0,0.08)' }}>
            <Title level={4} style={{ textAlign: 'center' }}>
              <ThunderboltOutlined /> 用户门户
            </Title>
            <Form layout="vertical" onFinish={(v) => void doLogin(v)}>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="用户名" autoComplete="username" />
              </Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password placeholder="密码" autoComplete="current-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loginLoading}>
                登录
              </Button>
            </Form>
          </Card>
        </Layout>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {messageContextHolder}
      <Layout className={pageClass}>
        <Layout.Content style={{ padding: 24 }}>
          <div style={{ maxWidth: 1000, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Title level={4} style={{ margin: 0 }}>
                <ThunderboltOutlined /> 用户门户
              </Title>
              <Space>
                <Button icon={<ReloadOutlined />} onClick={() => void loadAll()}>刷新</Button>
                <Button icon={<KeyOutlined />} onClick={() => setPwdOpen(true)}>修改密码</Button>
                <Button icon={<LogoutOutlined />} onClick={doLogout}>退出</Button>
              </Space>
            </div>

            {status && (
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space wrap size="large">
                  <Text strong>账号：{status.username}</Text>
                  <Text>
                    已用客户端：<Text strong>{status.usedClients}</Text>
                    {status.clientLimit > 0 ? <> / {status.clientLimit} 上限</> : '（不限量）'}
                  </Text>
                  {remaining !== null && (
                    <Tag color={remaining === 0 ? 'red' : 'green'}>剩余可添加：{remaining} 个</Tag>
                  )}
                  <Text type="secondary">可用入站：{inbounds.length} 个</Text>
                </Space>
              </Card>
            )}

            <Card size="small" title="🚀 客户端生成" style={{ marginBottom: 16 }}>
              <Row gutter={[16, 12]}>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="Email 前缀" style={{ marginBottom: 0 }}>
                    <Input
                      defaultValue={DEFAULT_GEN.emailPrefix}
                      onChange={(e) => setGenValues((v) => ({ ...v, emailPrefix: e.target.value }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="Email 后缀" style={{ marginBottom: 0 }}>
                    <Input
                      defaultValue={DEFAULT_GEN.emailSuffix}
                      onChange={(e) => setGenValues((v) => ({ ...v, emailSuffix: e.target.value }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="流量限制 (GB)" style={{ marginBottom: 0 }}>
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      value={genValues.totalGB}
                      onChange={(v) => setGenValues((prev) => ({ ...prev, totalGB: v || 0 }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="有效期天数 (0=永久)" style={{ marginBottom: 0 }}>
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      value={genValues.expiryDays}
                      onChange={(v) => setGenValues((prev) => ({ ...prev, expiryDays: v || 0 }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="目标入站" style={{ marginBottom: 0 }}>
                    <Select
                      style={{ width: '100%' }}
                      placeholder="选择入站"
                      value={genValues.inboundId || undefined}
                      onChange={(v) => setGenValues((prev) => ({ ...prev, inboundId: v }))}
                      options={inbounds.map((ib) => ({ value: ib.id, label: inboundLabel(ib.id) }))}
                      showSearch={{ optionFilterProp: 'label' }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="命名规则" style={{ marginBottom: 0 }}>
                    <select
                      style={{ width: '100%', height: 32, border: '1px solid #d9d9d9', borderRadius: 6, padding: '0 8px' }}
                      value={genValues.namingMode}
                      onChange={(e) => {
                        const val = e.target.value as 'ip' | 'seq';
                        setGenNamingMode(val);
                        setGenValues((prev) => ({ ...prev, namingMode: val }));
                      }}
                    >
                      <option value="ip">使用 IP 命名</option>
                      <option value="seq">顺序数字命名</option>
                    </select>
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12} md={6}>
                  <Form.Item label="XTLS Vision Flow" style={{ marginBottom: 0 }}>
                    <Space>
                      <Switch
                        checked={genValues.enableVision}
                        onChange={(v) => setGenValues((prev) => ({ ...prev, enableVision: v }))}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {inbounds.find((ib) => ib.id === genValues.inboundId)?.protocol === 'vless' ? '' : ' (仅 VLESS 生效)'}
                      </Text>
                    </Space>
                  </Form.Item>
                </Col>
                {genNamingMode === 'seq' && (
                  <>
                    <Col xs={24} sm={12} md={6}>
                      <Form.Item label="起始数字" style={{ marginBottom: 0 }}>
                        <InputNumber
                          style={{ width: '100%' }}
                          min={1}
                          value={genValues.startNum}
                          onChange={(v) => setGenValues((prev) => ({ ...prev, startNum: v || 1 }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12} md={6}>
                      <Form.Item label="补零位数" style={{ marginBottom: 0 }}>
                        <InputNumber
                          style={{ width: '100%' }}
                          min={1}
                          max={5}
                          value={genValues.padLength}
                          onChange={(v) => setGenValues((prev) => ({ ...prev, padLength: v || 2 }))}
                        />
                      </Form.Item>
                    </Col>
                  </>
                )}
              </Row>
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  上游节点列表（用于生成客户端命名） 格式: <Text code>前缀:IP:端口:账号:密码</Text> 或 <Text code>IP:端口:账号:密码</Text>
                </Text>
                <TextArea
                  rows={4}
                  value={nodeInput}
                  onChange={(e) => onNodeInputChange(e.target.value)}
                  placeholder={'香港节点:198.65.65.250:7176:user:pass\n日本节点:198.65.122.168:6808:user:pass'}
                  style={{ marginTop: 8 }}
                />
              </div>
              <Space style={{ marginTop: 12 }} wrap>
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={onGenerate}>
                  生成预览
                </Button>
                {previewEmails.length > 0 && (
                  <Button type="primary" icon={<SendOutlined />} loading={creating} onClick={() => void onCreate()}>
                    创建 {previewEmails.length} 个客户端
                  </Button>
                )}
              </Space>
              {previewEmails.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Text strong>预览（{previewEmails.length} 个）：</Text>
                  <Space wrap size={4} style={{ marginTop: 8 }}>
                    {previewEmails.map((email) => <Tag key={email} color="blue">{email}</Tag>)}
                  </Space>
                </div>
              )}
              {remaining !== null && remaining === 0 && (
                <Alert type="warning" showIcon style={{ marginTop: 12 }} message="已达到客户端数量上限，无法继续添加。" />
              )}
            </Card>

            <Card size="small" title={`我的客户端（${clients.length}）`}>
              <Table<PortalClientView>
                rowKey="email"
                columns={columns}
                dataSource={clients}
                loading={loading}
                size="small"
                pagination={{ pageSize: 10, showSizeChanger: false }}
                scroll={{ x: 720 }}
                locale={{ emptyText: '暂无客户端' }}
              />
            </Card>
          </div>
        </Layout.Content>
      </Layout>

      <Modal
        title={`二维码 / 链接 — ${qrClient?.email || ''}`}
        open={qrOpen}
        onCancel={() => setQrOpen(false)}
        footer={<Button onClick={() => setQrOpen(false)}>关闭</Button>}
        destroyOnHidden
      >
        {qrLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : qrLinks && (qrLinks.links.length > 0 || qrLinks.subLink) ? (
          <Collapse
            defaultActiveKey={qrLinks.subLink ? ['sub'] : qrLinks.links.length > 0 ? ['l0'] : []}
            items={[
              ...(qrLinks.subLink
                ? [{
                    key: 'sub',
                    label: '订阅链接',
                    children: (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                        <QrPanel value={qrLinks.subLink} remark={`${qrClient?.email || ''} — 订阅`} size={200} />
                        <Text copyable style={{ wordBreak: 'break-all', maxWidth: 420 }}>{qrLinks.subLink}</Text>
                      </div>
                    ),
                  }]
                : []),
              ...qrLinks.links.map((link, idx) => ({
                key: `l${idx}`,
                label: `分享链接 ${idx + 1}`,
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    <QrPanel value={link} remark={`${qrClient?.email || ''} #${idx + 1}`} size={200} />
                    <Text copyable style={{ wordBreak: 'break-all', maxWidth: 420 }}>{link}</Text>
                  </div>
                ),
              })),
            ]}
          />
        ) : (
          <Alert type="info" showIcon message="该客户端暂无可用链接（可能订阅未开启或入站不支持分享链接）。" />
        )}
      </Modal>

      <Modal
        title="修改密码"
        open={pwdOpen}
        onOk={() => void changePassword()}
        onCancel={() => setPwdOpen(false)}
        confirmLoading={pwdLoading}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </ConfigProvider>
  );
}
