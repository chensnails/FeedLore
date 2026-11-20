/* 设置弹层「账号」面板（原 index.html 内联 DOM + app.js 绑定迁移至此）。
 *
 * 结构（v2.5.0 设置 A 方案）：
 * - 登录信息 / 数据导出 / 导入 / 备份 / 还原 / 安装仍按折叠分组摆放（表单类，见 primitives.Section）；
 * - 登录设备、用户管理改成「紧凑列表 + 详情层」：行只留头像 / 名称 / 状态，点行打开 DetailSheet
 *   做逐台退出、改角色、改密码、删除；新增用户也收进详情层，列表不再被一排输入框撑长；
 * - 行内与层内的操作都是「即改即生效」，失败直接写在层里 / 分组里的 Result。
 *
 * 拆分为同目录模块：AccountPane.utils.ts（纯函数/类型）、AccountPane.controller.ts（状态与操作）、
 * AccountPane.sections.tsx（展示分组）、AccountPane.sheets.tsx（三个详情层）。
 */

import { useAccountController } from './AccountPane.controller.ts';
import {
  DevicesSection,
  InstallSection,
  LoginSection,
  UsersSection,
} from './AccountPane.sections.tsx';
import { AddUserSheet, DeviceSheet, UserSheet } from './AccountPane.sheets.tsx';
import { PaneFoot, Result, Section } from './primitives.tsx';

export function AccountPane({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const c = useAccountController(onDirtyChange);

  return (
    <div className="tab-pane" data-pane="account" ref={c.paneRef}>
      <div className="pane-scroll">
        <Result id="accResult" result={c.accResult} />

        <LoginSection
          readonly={c.readonly}
          editLogin={c.editLogin}
          username={c.username}
          savedName={c.savedName}
          current={c.current}
          newPass={c.newPass}
          setUsername={c.setUsername}
          setCurrent={c.setCurrent}
          setNewPass={c.setNewPass}
          setEditLogin={c.setEditLogin}
          closeEditLogin={c.closeEditLogin}
        />

        {/* 登录设备（会话）：紧凑列表，点行看详情 / 退出 */}
        <DevicesSection
          devResult={c.devResult}
          devicesError={c.devicesError}
          devicesLoaded={c.devicesLoaded}
          devices={c.devices}
          loadDevices={c.loadDevices}
          onOpenDevice={(id: string) => c.setSheet({ type: 'device', id })}
          revoking={c.revoking}
          revokeOthers={c.revokeOthers}
          otherDevices={c.otherDevices}
        />

        {/* 数据导出：账号级存档，换机或长期留存用 */}
        <Section secKey="acc-export" advanced title="数据导出" sub="tar.gz">
          <p className="hint">
            <b>包含</b>：本账号的订阅源、全部文章（含已读 / 收藏 / 关注标记）、日报与偏好设置。
            <br />
            <b>不含</b>：登录会话、图片缓存与全文抓取缓存。
          </p>
          {!c.readonly && (
            <div className="form-row">
              <label className="form-row-head">
                <span>连同模型 API Key 一起导出</span>
                <span className="switch">
                  <input
                    id="exportLlm"
                    type="checkbox"
                    checked={c.inclLlm}
                    onChange={/** @param {*} [e] */ (e) => c.setInclLlm(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </span>
              </label>
              <small className="form-tip">
                勾选后 llm.json 里是解密的明文 Key，文件请只放在受控位置。
              </small>
            </div>
          )}
          <div className="dev-actions">
            <button
              className="btn btn-ghost btn-sm"
              id="exportBtn"
              type="button"
              disabled={c.exporting}
              aria-busy={c.exporting}
              onClick={c.startExport}
            >
              {c.exporting ? '生成中…' : '下载导出包'}
            </button>
          </div>
          <small className="form-tip">
            包内 manifest.json 写明格式版本与条数，文章按 entries-0001.jsonl
            分批；换机或回滚时在下方「数据导入」里原样上传即可。
          </small>
        </Section>

        {/* 数据导入：账号级增量合并（只读账户由服务端拒绝写操作，不展示） */}
        {!c.readonly && (
          <Section secKey="acc-import" advanced title="数据导入" sub="tar.gz">
            <p className="hint">
              上传本账号的导出包，把频道、文章标记、日报与偏好合并进来。
              <br />
              <b>合并规则</b>：已存在的频道与文章会跳过，现有文章的已读 / 收藏 /
              关注状态不会被改动。
              <br />
              <b>模型配置</b>
              ：包里若带（导出时勾选），只在这个账号还没配过模型时写入，并用本机主密钥重新加密。
            </p>
            <div className="dev-actions">
              <button
                className="btn btn-ghost btn-sm"
                id="importBtn"
                type="button"
                disabled={c.importing}
                aria-busy={c.importing}
                onClick={() => document.getElementById('importFile')?.click()}
              >
                {c.importing ? '导入中…（文件大时需要一点时间）' : '选择导出包并导入'}
              </button>
              <input
                id="importFile"
                type="file"
                accept=".gz,application/gzip,application/x-gzip"
                hidden
                onChange={c.importArchive}
              />
            </div>
            <Result id="importResult" result={c.importMsg} />
            <small className="form-tip">
              导入只做增量合并，不会删除现有数据。
              <br />
              模型 API Key
              只有在导出时勾选才会在包里；写入时用的是本机的加密主密钥，不是包里的那份。
              <br />
              这里只收「数据导出」的账号包，整站备份请到下方「整站还原」上传。
            </small>
          </Section>
        )}

        {/* 用户管理：仅管理员可见，紧凑列表 + 详情层 */}
        {c.admin && (
          <UsersSection
            userResult={c.userResult}
            usersSub={c.usersSub}
            usersLoaded={c.usersLoaded}
            usersError={c.usersError}
            loadUsers={c.loadUsers}
            users={c.users}
            onOpenUser={(id: string) => c.setSheet({ type: 'user', id })}
            userBusy={c.userBusy}
            onAddUser={() => c.setSheet({ type: 'addUser' })}
          />
        )}

        {/* 整站备份：管理员级、含敏感数据，单独分组并走危险确认 */}
        {c.admin && (
          <Section secKey="acc-backup" advanced title="整站备份" sub="仅管理员">
            <p className="hint">
              <b>包含</b>
              ：所有账号（含密码哈希）、订阅源与文章、日报、模型配置、站点设置与图片缓存。
              <br />
              <b>敏感</b>：这是敏感文件，请只保存在受控位置。
              <br />
              <b>不含</b>：登录会话；恢复后所有人需要重新登录。
            </p>
            <div className="dev-actions">
              <button
                className="btn btn-danger btn-sm"
                id="backupBtn"
                type="button"
                disabled={c.backingUp}
                aria-busy={c.backingUp}
                onClick={c.startBackup}
              >
                {c.backingUp ? '生成中…' : '下载整站备份'}
              </button>
            </div>
            <small className="form-tip">
              同一时间只允许生成一份；换机时可在下方「整站还原」里上传该备份包直接还原。
            </small>
          </Section>
        )}

        {/* 整站还原：清库覆盖、全员掉线，两次确认后才会真正执行 */}
        {c.admin && (
          <Section secKey="acc-restore" advanced title="整站还原" sub="仅管理员">
            <p className="hint">
              上传整站备份包，用它<b>整体替换</b>
              当前全站数据：账号（含密码）、订阅源与文章、日报、模型配置、站点设置与图片缓存。
              <br />
              <b>影响</b>：还原期间站点短暂不可用，结束后所有登录会话失效。
            </p>
            <div className="dev-actions">
              <button
                className="btn btn-danger btn-sm"
                id="restoreBtn"
                type="button"
                disabled={c.restoring}
                aria-busy={c.restoring}
                onClick={() => document.getElementById('restoreFile')?.click()}
              >
                {c.restoring ? '还原中…（请勿关闭页面）' : '上传备份并还原'}
              </button>
              <input
                id="restoreFile"
                type="file"
                accept=".gz,application/gzip,application/x-gzip"
                hidden
                onChange={c.restoreSite}
              />
            </div>
            <Result id="restoreResult" result={c.restoreMsg} />
            <small className="form-tip">
              还原不做合并，先清空再写入，不可撤销；建议先下载当前整站备份留底。只接受本系统导出的
              tar.gz。 这里只收「整站备份」，账号导出包请到上方「数据导入」上传。
              还原后建议重启一次服务，让进程加载包内的站点设置（含登录签名密钥）。
            </small>
          </Section>
        )}

        {/* 装到桌面属于「看一次就够」的内容，默认收起 */}
        <InstallSection onInstall={c.install} />
      </div>

      {c.sheetDevice ? (
        <DeviceSheet
          key={'dev-' + c.sheetDevice.id}
          device={c.sheetDevice}
          busy={c.revoking === c.sheetDevice.id}
          onClose={() => c.setSheet(null)}
          onRevoke={c.revokeDevice}
        />
      ) : null}
      {c.sheetUser ? (
        <UserSheet
          key={'user-' + c.sheetUser.id}
          user={c.sheetUser}
          busy={!!c.userBusy}
          onClose={() => c.setSheet(null)}
          onRole={c.changeUserRole}
          onPassword={c.setUserPassword}
          onDelete={c.deleteUser}
        />
      ) : null}
      {c.sheet && c.sheet.type === 'addUser' ? (
        <AddUserSheet
          busy={c.userBusy === 'add'}
          onClose={() => c.setSheet(null)}
          onCreate={c.createUser}
        />
      ) : null}

      <PaneFoot
        dirty={c.dirty}
        lead={
          <button type="button" className="btn btn-danger btn-sm" id="logoutBtn" onClick={c.logout}>
            退出登录
          </button>
        }
      >
        {!c.readonly && (
          <button
            type="button"
            className="btn btn-primary"
            id="saveAccBtn"
            aria-busy={c.saving ? 'true' : undefined}
            disabled={c.saving || !c.dirty}
            onClick={c.saveAccount}
          >
            {c.saving ? '保存中…' : '保存账号'}
          </button>
        )}
      </PaneFoot>
    </div>
  );
}
