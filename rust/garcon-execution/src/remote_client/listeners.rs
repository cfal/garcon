use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    rc::Rc,
};

pub(super) struct Listeners<T: ?Sized> {
    next_id: Cell<u64>,
    callbacks: RefCell<BTreeMap<u64, Rc<T>>>,
}

impl<T: ?Sized> Default for Listeners<T> {
    fn default() -> Self {
        Self {
            next_id: Cell::default(),
            callbacks: RefCell::default(),
        }
    }
}

impl<T: ?Sized + 'static> Listeners<T> {
    pub fn subscribe(self: &Rc<Self>, callback: Rc<T>) -> Box<dyn Fn()> {
        let mut callbacks = self.callbacks.borrow_mut();
        let id = callbacks
            .iter()
            .find_map(|(id, listener)| Rc::ptr_eq(listener, &callback).then_some(*id));
        let id = id.unwrap_or_else(|| {
            let id = self.next_id.get();
            self.next_id.set(id.wrapping_add(1));
            callbacks.insert(id, callback);
            id
        });
        let listeners = Rc::downgrade(self);
        Box::new(move || {
            if let Some(listeners) = listeners.upgrade() {
                listeners.callbacks.borrow_mut().remove(&id);
            }
        })
    }

    pub fn clear(&self) {
        self.callbacks.borrow_mut().clear();
    }

    pub fn for_each(&self, mut invoke: impl FnMut(&T)) {
        let mut lower = Unbounded;
        loop {
            let next = self
                .callbacks
                .borrow()
                .range((lower, Unbounded))
                .next()
                .map(|(id, callback)| (*id, callback.clone()));
            let Some((id, callback)) = next else {
                break;
            };
            lower = Excluded(id);
            invoke(&callback);
        }
    }
}
