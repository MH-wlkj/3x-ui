import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Select,
  Space,
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
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import { useTheme } from '@/hooks/useTheme';
import { HttpUtil, SizeFormatter } from '@/utils';
import { setMessageInstance } from '@/utils/messageBus';
import type { InboundOption } from '@/schemas/client';
import type { PortalClientView, UserStatus } from '@/generated/types';
import '@/styles/page-shell.css';
import '@/styles/page-cards.css';
import '@/styles/utils.css';

const { Title, Text } = Typography;
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } } as const;
const TOKEN_KEY = 'portal_token';
const DAY_MS = 86400000;

interface CreateFormValues {
  inboundId: number;
  email: string;
  totalGB: number;
  expiryDays: number;
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
  const [createLoading, setCreateLoading] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [createForm] = Form.useForm<CreateFormValues>();
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

  const createClient = async (values: CreateFormValues) => {
    setCreateLoading(true);
    try {
      const payload = {
        inboundId: values.inboundId,
        email: values.email,
        totalGB: Math.round((values.totalGB || 0) * SizeFormatter.ONE_GB),
        expiryTime: (values.expiryDays || 0) > 0 ? Date.now() + (values.expiryDays || 0) * DAY_MS : 0,
      };
      const msg = await HttpUtil.post('/portal/api/clients', payload, authHeaders(JSON_HEADERS.headers));
      if (msg?.success) {
        messageApi.success('客户端已创建');
        createForm.resetFields();
        void loadAll();
      } else {
        messageApi.error(msg?.msg || '创建失败');
      }
    } finally {
      setCreateLoading(false);
    }
  };

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
      width: 90,
      render: (_v, r) => (
        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteClient(r)}>
          删除
        </Button>
      ),
    },
  ], [inboundLabel, deleteClient]);

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

            <Card size="small" title="添加客户端" style={{ marginBottom: 16 }}>
              <Form form={createForm} layout="inline" onFinish={(v) => void createClient(v)} style={{ rowGap: 12 }}>
                <Form.Item name="inboundId" label="目标入站" rules={[{ required: true, message: '请选择入站' }]} style={{ minWidth: 220 }}>
                  <Select
                    placeholder="选择入站"
                    options={inbounds.map((ib) => ({ value: ib.id, label: inboundLabel(ib.id) }))}
                    showSearch={{ optionFilterProp: 'label' }}
                  />
                </Form.Item>
                <Form.Item name="email" label="客户端邮箱" rules={[{ required: true, message: '请输入邮箱' }]}>
                  <Input placeholder="如 user-001" />
                </Form.Item>
                <Form.Item name="totalGB" label="流量 (GB)" initialValue={0}>
                  <InputNumber min={0} style={{ width: 120 }} placeholder="0=不限" />
                </Form.Item>
                <Form.Item name="expiryDays" label="有效期 (天)" initialValue={0}>
                  <InputNumber min={0} style={{ width: 110 }} placeholder="0=永久" />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={createLoading}>
                    添加
                  </Button>
                </Form.Item>
              </Form>
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
