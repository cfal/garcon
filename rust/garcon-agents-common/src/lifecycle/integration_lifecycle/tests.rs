use std::rc::Rc;

use super::*;

#[tokio::test]
async fn start_and_stop_are_idempotent_and_failed_start_releases_partial_ownership() {
    let starts = Rc::new(Cell::new(0));
    let stops = Rc::new(Cell::new(0));
    let start_count = starts.clone();
    let stop_count = stops.clone();
    let lifecycle = IntegrationLifecycle::new(IntegrationLifecycleOptions {
        start: Some(Box::new(move || {
            let starts = start_count.clone();
            Box::pin(async move {
                let count = starts.get() + 1;
                starts.set(count);
                if count == 1 {
                    return Err("boom".into());
                }
                Ok(())
            })
        })),
        stop: Some(Box::new(move || {
            let stops = stop_count.clone();
            Box::pin(async move {
                stops.set(stops.get() + 1);
                Ok(())
            })
        })),
        ..Default::default()
    });
    assert_eq!(lifecycle.start().await.unwrap_err().to_string(), "boom");
    assert_eq!(stops.get(), 1);
    lifecycle.start().await.unwrap();
    lifecycle.start().await.unwrap();
    lifecycle.stop().await.unwrap();
    lifecycle.stop().await.unwrap();
    assert_eq!((starts.get(), stops.get()), (2, 2));
}
