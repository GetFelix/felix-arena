/// The fixed part at the front of every tick record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Header {
    /// Which run of the simulation wrote the tick; a restart takes the next.
    pub(crate) epoch: u16,
    /// Whether the tick holds the whole match state.
    pub(crate) keyframe: bool,
    pub(crate) match_number: u32,
    pub(crate) tick: u32,
}

impl Header {
    pub(crate) const LEN: usize = 12;
    const KEYFRAME: u8 = 1;

    /// Little-endian: epoch (2 bytes), flags (1), reserved (1), match (4),
    /// tick (4).
    pub(crate) fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..2].copy_from_slice(&self.epoch.to_le_bytes());
        out[2] = if self.keyframe { Self::KEYFRAME } else { 0 };
        out[4..8].copy_from_slice(&self.match_number.to_le_bytes());
        out[8..12].copy_from_slice(&self.tick.to_le_bytes());
        out
    }

    #[cfg(test)]
    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        let bytes: &[u8; Self::LEN] = bytes.get(..Self::LEN)?.try_into().ok()?;
        Some(Self {
            epoch: u16::from_le_bytes([bytes[0], bytes[1]]),
            keyframe: bytes[2] & Self::KEYFRAME != 0,
            match_number: u32::from_le_bytes(bytes[4..8].try_into().ok()?),
            tick: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Header;

    #[test]
    fn round_trips() {
        let header = Header {
            epoch: 7,
            keyframe: true,
            match_number: 3,
            tick: 0x0102_0304,
        };
        let bytes = header.encode();
        assert_eq!(bytes, [7, 0, 1, 0, 3, 0, 0, 0, 4, 3, 2, 1]);
        assert_eq!(Header::decode(&bytes), Some(header));
    }

    #[test]
    fn short_input_is_not_a_header() {
        assert_eq!(Header::decode(&[0; 11]), None);
    }
}
