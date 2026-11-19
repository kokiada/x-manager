import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import {
  createGroup,
  createProxyGroup,
  deleteGroup,
  deleteProxyGroup,
  renameGroup,
} from '../db/repository';
import { Button, useToast } from './ui';

/**
 * Manage account groups and proxy groups.
 * Deleting either un-assigns its accounts rather than deleting them
 * (XBoard CSV spec: a group with no accounts disappears).
 */
export function GroupManager({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const proxyGroups = useLiveQuery(() => db.proxyGroups.toArray(), [], []);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);

  const [newGroupName, setNewGroupName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const [pxName, setPxName] = useState('');
  const [pxHost, setPxHost] = useState('');
  const [pxPort, setPxPort] = useState('');
  const [pxUser, setPxUser] = useState('');

  const countInGroup = (id: string) => accounts?.filter((a) => a.groupId === id).length ?? 0;
  const countInProxy = (id: string) =>
    accounts?.filter((a) => a.proxyGroupId === id).length ?? 0;

  const addGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    await createGroup(name);
    setNewGroupName('');
    toast.push(`グループ「${name}」を作成しました`, 'ok');
  };

  const saveRename = async (id: string) => {
    const name = editingName.trim();
    if (!name) return;
    await renameGroup(id, name);
    setEditingId(null);
    toast.push('グループ名を変更しました', 'ok');
  };

  const removeGroup = async (id: string, name: string) => {
    if (!window.confirm(`グループ「${name}」を削除しますか？所属アカウントは未分類になります。`))
      return;
    await deleteGroup(id);
    toast.push(`グループ「${name}」を削除しました`, 'ok');
  };

  const addProxy = async () => {
    const name = pxName.trim();
    const host = pxHost.trim();
    const port = Number(pxPort);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.push('プロキシ名・ホスト・ポート（1–65535）を正しく入力してください', 'err');
      return;
    }
    await createProxyGroup({
      name,
      host,
      port,
      username: pxUser.trim() || undefined,
    });
    setPxName(''); setPxHost(''); setPxPort(''); setPxUser('');
    toast.push(`プロキシグループ「${name}」を作成しました`, 'ok');
  };

  const removeProxy = async (id: string, name: string) => {
    if (
      !window.confirm(
        `プロキシグループ「${name}」を削除しますか？割り当て中のアカウントは直接接続（なし）になります。`,
      )
    )
      return;
    await deleteProxyGroup(id);
    toast.push(`プロキシグループ「${name}」を削除しました`, 'ok');
  };

  return (
    <div>
      <h3 className="section-title" style={{ marginTop: 0 }}>アカウントグループ</h3>
      {(groups ?? []).map((g) => (
        <div key={g.id} className="toolbar" style={{ marginBottom: 8 }}>
          {editingId === g.id ? (
            <>
              <input
                type="search"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                aria-label="グループ名"
                style={{ flex: 1 }}
              />
              <Button small variant="primary" onClick={() => saveRename(g.id)}>
                保存
              </Button>
              <Button small variant="ghost" onClick={() => setEditingId(null)}>
                中止
              </Button>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 700 }}>{g.name}</span>
              <span className="mono faded">{countInGroup(g.id)} 件</span>
              <span className="spacer" />
              <Button
                small
                variant="ghost"
                onClick={() => {
                  setEditingId(g.id);
                  setEditingName(g.name);
                }}
              >
                名前変更
              </Button>
              <Button small variant="danger" onClick={() => removeGroup(g.id, g.name)}>
                削除
              </Button>
            </>
          )}
        </div>
      ))}
      <div className="toolbar">
        <input
          type="search"
          placeholder="新しいグループ名"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          aria-label="新しいグループ名"
          style={{ flex: 1 }}
        />
        <Button small variant="primary" onClick={addGroup} disabled={!newGroupName.trim()}>
          グループ作成
        </Button>
      </div>

      <h3 className="section-title">プロキシグループ</h3>
      <p className="faded" style={{ fontSize: 12.5, marginTop: 0 }}>
        推奨は1プロキシあたり5アカウント程度まで（XBoard公式FAQの目安）。
      </p>
      {(proxyGroups ?? []).map((p) => (
        <div key={p.id} className="toolbar" style={{ marginBottom: 8 }}>
          <span style={{ fontWeight: 700 }}>{p.name}</span>
          <span className="mono faded">
            {p.host}:{p.port}
          </span>
          <span className="mono faded">{countInProxy(p.id)} 件割当</span>
          <span className="spacer" />
          <Button small variant="danger" onClick={() => removeProxy(p.id, p.name)}>
            削除
          </Button>
        </div>
      ))}
      <div className="form-row">
        <div className="field">
          <label htmlFor="px-name">プロキシ名</label>
          <input id="px-name" value={pxName} onChange={(e) => setPxName(e.target.value)} placeholder="東京プロキシ C" />
        </div>
        <div className="field">
          <label htmlFor="px-user">認証ユーザー名（任意）</label>
          <input id="px-user" value={pxUser} onChange={(e) => setPxUser(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="px-host">ホスト</label>
          <input id="px-host" value={pxHost} onChange={(e) => setPxHost(e.target.value)} placeholder="proxy.example.jp" />
        </div>
        <div className="field">
          <label htmlFor="px-port">ポート</label>
          <input id="px-port" value={pxPort} onChange={(e) => setPxPort(e.target.value)} inputMode="numeric" placeholder="8080" />
        </div>
      </div>
      <div className="modal-actions">
        <Button onClick={addProxy}>プロキシグループ作成</Button>
        <Button variant="primary" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </div>
  );
}
