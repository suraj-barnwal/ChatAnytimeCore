namespace ChatAPI.DTOs
{
    public sealed class DeleteMessagesRequest
    {
        public List<int> MessageIds { get; set; } = new();
        public string Scope { get; set; } = "me";
    }
}
