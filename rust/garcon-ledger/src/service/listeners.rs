use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    rc::Rc,
};

pub(super) struct OrderedListeners<T: ?Sized> {
    entries: RefCell<BTreeMap<u64, Rc<T>>>,
    last_id: Cell<u64>,
}

impl<T: ?Sized> Default for OrderedListeners<T> {
    fn default() -> Self {
        Self {
            entries: RefCell::new(BTreeMap::new()),
            last_id: Cell::new(0),
        }
    }
}

impl<T: ?Sized + 'static> OrderedListeners<T> {
    pub(super) fn subscribe(self: &Rc<Self>, listener: Rc<T>) -> Box<dyn Fn()> {
        let mut entries = self.entries.borrow_mut();
        if !entries.values().any(|entry| Rc::ptr_eq(entry, &listener)) {
            let id = self.last_id.get() + 1;
            self.last_id.set(id);
            entries.insert(id, Rc::clone(&listener));
        }
        let listeners = Rc::downgrade(self);
        Box::new(move || {
            if let Some(listeners) = listeners.upgrade() {
                listeners
                    .entries
                    .borrow_mut()
                    .retain(|_, entry| !Rc::ptr_eq(entry, &listener));
            }
        })
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = Rc<T>> + '_ {
        let mut last = 0;
        std::iter::from_fn(move || {
            // Callbacks can change the set without keeping its borrow between calls.
            let entries = self.entries.borrow();
            let (&id, listener) = entries.range((Excluded(last), Unbounded)).next()?;
            last = id;
            Some(Rc::clone(listener))
        })
    }

    pub(super) fn clear(&self) {
        drop(self.entries.take());
    }
}
