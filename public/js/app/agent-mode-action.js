export function initSessionCreateAction(button, { createSession, onError }) {
  let creating = false;
  const sync = () => {
    button.setAttribute('aria-label', creating ? '正在创建会话' : '新建会话');
    button.title = creating ? '正在创建会话…' : '新建会话';
    button.disabled = creating;
    button.setAttribute('aria-busy', String(creating));
  };
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (creating) return;
    creating = true; sync();
    try { await createSession(); } catch (error) { onError(error); }
    finally { creating = false; sync(); }
  });
  sync();
  return { sync };
}
