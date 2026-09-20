// The wand menu is created asynchronously by SillyTavern during startup.
export function mountStudioEntry(openPanel) {
    let observer;
    const mount = () => {
        const menu = document.querySelector('#extensionsMenu');
        if (!menu) return false;
        if (document.querySelector('#breeze_studio_wand_entry')) return true;
        const container = document.createElement('div');
        container.id = 'breeze_studio_wand_container'; container.className = 'extension_container';
        const entry = document.createElement('div');
        entry.id = 'breeze_studio_wand_entry';
        entry.className = 'list-group-item flex-container flexGap5 interactable breeze-wand-entry';
        entry.tabIndex = 0; entry.setAttribute('role', 'button'); entry.setAttribute('aria-haspopup', 'dialog');
        entry.setAttribute('aria-controls', 'breeze-studio-dialog');
        const icon = document.createElement('span');
        icon.className = 'fa-fw fa-solid fa-wave-square extensionsMenuExtensionButton'; icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = 'Breeze 语音工作室';
        entry.append(icon, label); container.append(entry); menu.append(container);
        entry.addEventListener('click', () => openPanel());
        entry.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.click(); }
        });
        return true;
    };
    if (!mount()) {
        observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => { observer?.disconnect(); document.querySelector('#breeze_studio_wand_container')?.remove(); };
}
