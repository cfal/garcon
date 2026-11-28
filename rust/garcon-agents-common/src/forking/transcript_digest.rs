use garcon_contract::chat_types::ChatMessage;
use garcon_interface::resources::ExecutorResult;
use twox_hash::XxHash32;

#[derive(Default)]
pub struct OrderedTranscriptDigest {
    sum_a: u32,
    sum_b: u32,
    count: u64,
}

impl OrderedTranscriptDigest {
    pub fn add(&mut self, message: &ChatMessage) -> ExecutorResult<()> {
        self.count += 1;
        let serialized = serde_json::to_vec(message)?;
        let position = format!(r#"{{"seq":{}}}"#, self.count);
        let hash_a = mix_hash(
            XxHash32::oneshot(0x9e37_79b9, &serialized),
            XxHash32::oneshot(0xc2b2_ae35, b"ordered-message"),
        );
        let hash_b = mix_hash(
            murmur(&serialized, 0x85eb_ca6b)?,
            murmur(b"ordered-message", 0x27d4_eb2d)?,
        );
        self.sum_a = self.sum_a.wrapping_add(mix_hash(
            hash_a,
            XxHash32::oneshot(0x1656_67b1, position.as_bytes()),
        ));
        self.sum_b = self
            .sum_b
            .wrapping_add(mix_hash(hash_b, murmur(position.as_bytes(), 0x0100_0193)?));
        Ok(())
    }

    pub fn digest(&self) -> String {
        format!(
            "ordered-v1:{}:{:08x}{:08x}",
            self.count, self.sum_a, self.sum_b
        )
    }
}

fn murmur(mut bytes: &[u8], seed: u32) -> std::io::Result<u32> {
    murmur3::murmur3_32(&mut bytes, seed)
}

fn mix_hash(left: u32, right: u32) -> u32 {
    (left ^ right.rotate_left(13)).wrapping_mul(0x9e37_79b1)
}

#[cfg(test)]
mod tests;
