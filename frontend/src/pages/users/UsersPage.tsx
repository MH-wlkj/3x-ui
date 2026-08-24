import { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  TeamOutlined,
} from '@ant-design/icons';

import { useTheme } from '@/hooks/useTheme';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useInboundOptions } from '@/api/queries/useInboundOptions';
import { HttpUtil } from '@/utils';
import { setMessageInstance } from '@/utils/messageBus';
import AppSidebar from '@/layouts/AppSidebar';
import { type InboundOption } from '@/schemas/client';
import { type PanelUser } from '@/generated/types';
import '@/styles/page-shell.css';
import '@/styles/page-cards.css';
import '@/styles/utils.css';

const { Title, Text } = Typography;
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } } as const;

interface UserFormValues {
  id?: number;
  username: string;
  password: string;
  inboundIds: number[];
  clientLimit: number;
  enable: boolean;
}

async function fetchUsers(): Promise<PanelUser[]> {
  const msg = await HttpUtil.get<PanelUser[]>('/panel/api/portal/users', undefined, { silent: true });
  return msg?.success && Array.isArray(msg.obj) ? msg.obj : [];
}

export default function UsersPage() {
  usePageTitle();
  const { isDark, isUltra, antdThemeConfig } = useTheme();
  const [messageApi, messageContextHolder] = message.useMessage();
  useEffect(() => { setMessageInstance(messageApi); }, [messageApi]);

  const [users, setUsers] = useState<PanelUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PanelUser | null>(null);
  const [form] = Form.useForm<UserFormValues>();
  const { data: inbounds, isLoading: inboundsLoading } = useInboundOptions();

  const inboundLabel = useCallback(
    (id: number) => {
      const ib = (inbounds ?? []).find((x: InboundOption) => x.id === id);
      return ib ? `${ib.protocol || '?'} | ${ib.nodeName || ib.remark || ib.tag || `#${id}`}` : `#${id}`;
    },
    [inbounds],
  );

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await fetchUsers());
    } catch {
      messageApi.error('加载用户列表失败');
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ inboundIds: [], clientLimit: 0, enable: true });
    setModalOpen(true);
  };

  const openEdit = useCallback((user: PanelUser) => {
    setEditing(user);
    form.resetFields();
    form.setFieldsValue({
      id: user.id,
      username: user.username,
      password: '',
      inboundIds: user.inboundIds ?? [],
      clientLimit: user.clientLimit,
      enable: user.enable,
    });
    setModalOpen(true);
  }, [form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const url = editing ? '/panel/api/portal/users/update' : '/panel/api/portal/users/create';
      const msg = await HttpUtil.post(url, { ...values, id: editing?.id }, JSON_HEADERS);
      if (msg?.success) {
        messageApi.success(editing ? '用户已更新' : '用户已创建');
        setModalOpen(false);
        void loadUsers();
      } else {
        messageApi.error(msg?.msg || '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = useCallback((user: PanelUser) => {
    Modal.confirm({
      title: `删除用户 ${user.username}？`,
      content: '该用户的授权会被移除，但已创建的客户端不会受影响。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const msg = await HttpUtil.post('/panel/api/portal/users/delete', { id: user.id }, JSON_HEADERS);
        if (msg?.success) {
          messageApi.success('用户已删除');
          void loadUsers();
        } else {
          messageApi.error(msg?.msg || '删除失败');
        }
      },
    });
  }, [loadUsers, messageApi]);

  const columns: TableColumnsType<PanelUser> = useMemo(() => [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60, align: 'right' },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (v: string, r) => (
        <Space size={6}>
          <Text strong>{v}</Text>
          {!r.enable && <Tag color="red">已停用</Tag>}
        </Space>
      ),
    },
    {
      title: '可用入站',
      key: 'inboundIds',
      render: (_v, r) => {
        const ids = r.inboundIds ?? [];
        if (ids.length === 0) return <Tag>无</Tag>;
        return (
          <Space wrap size={4}>
            {ids.map((id) => (
              <Tag key={id} color="geekblue" style={{ fontSize: 11 }}>{inboundLabel(id)}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '客户端配额',
      dataIndex: 'clientLimit',
      key: 'clientLimit',
      width: 110,
      render: (v: number) => (v > 0 ? `${v} 个` : '不限'),
    },
    {
      title: '启用',
      dataIndex: 'enable',
      key: 'enable',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="green">是</Tag> : <Tag color="red">否</Tag>),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_v, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(r)}>删除</Button>
        </Space>
      ),
    },
  ], [inboundLabel, openEdit, remove]);

  const inboundOptions = useMemo(
    () => (inbounds ?? []).map((ib: InboundOption) => ({
      value: ib.id,
      label: `${ib.protocol || '?'} | ${ib.nodeName || ib.remark || ib.tag || `#${ib.id}`}`,
    })),
    [inbounds],
  );

  const pageClass = useMemo(() => {
    const classes = ['users-page'];
    if (isDark) classes.push('is-dark');
    if (isUltra) classes.push('is-ultra');
    return classes.join(' ');
  }, [isDark, isUltra]);

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {messageContextHolder}
      <Layout className={pageClass}>
        <AppSidebar />
        <Layout className="content-shell">
          <Layout.Content className="content-area" style={{ padding: 24 }}>
            <Card style={{ maxWidth: 1200, margin: '0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Title level={4} style={{ margin: 0 }}>
                  <TeamOutlined /> 用户管理
                </Title>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  添加用户
                </Button>
              </div>
              <Table<PanelUser>
                rowKey="id"
                columns={columns}
                dataSource={users}
                loading={loading || inboundsLoading}
                pagination={false}
                size="small"
                locale={{ emptyText: '暂无用户，点击右上角"添加用户"创建' }}
              />
              <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
                门户地址：/panel/portal —— 用户用自己的账号登录后，只能向被授权的入站添加客户端，且总数不超过配额。
              </Text>
            </Card>
          </Layout.Content>
        </Layout>
      </Layout>

      <Modal
        title={editing ? `编辑用户 ${editing.username}` : '添加用户'}
        open={modalOpen}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="用户登录名" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing ? '新密码（留空保持不变）' : '密码'}
            rules={editing ? [] : [{ required: true, message: '请输入密码' }]}
          >
            <Input.Password placeholder={editing ? '留空则不修改' : '登录密码'} autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="inboundIds" label="可用入站" rules={[{ required: true, message: '请选择至少一个入站' }]}>
            <Select
              mode="multiple"
              placeholder="选择该用户可使用的入站"
              options={inboundOptions}
              maxTagCount="responsive"
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              listHeight={220}
            />
          </Form.Item>
          <Form.Item name="clientLimit" label="客户端数量上限（0 = 不限）">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="最多可添加的客户端总数" />
          </Form.Item>
          <Form.Item name="enable" label="启用账号" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </ConfigProvider>
  );
}
